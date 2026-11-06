require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const pLimit = require('p-limit');
const pino = require('pino');
const pinoHttp = require('pino-http');

const { validateEmail } = require('./validators/emailValidator');
const { DomainCache } = require('./cache/domainCache');

// ---------------------------------------------------------------------------
// Structured logger (JSON). Used for all application + request logging.
// It intentionally never logs full email addresses or request bodies.
// ---------------------------------------------------------------------------
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const app = express();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT, 10) || 5000;
const MAX_BULK = parseInt(process.env.MAX_BULK, 10) || 100;
const BULK_CONCURRENCY = parseInt(process.env.CONCURRENCY, 10) || 10;
const DNS_TIMEOUT_MS = parseInt(process.env.DNS_TIMEOUT_MS, 10) || 5000;
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 900000; // 15 min
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX, 10) || 100;
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS, 10) || 5 * 60 * 1000; // 5 minutes
const API_KEY = process.env.API_KEY || null;

// Cross-request TTL cache for domain lookups (optional, 5 minutes by default).
const domainCache = new DomainCache({ ttlMs: CACHE_TTL_MS });

// CORS allowlist (comma-separated in CORS_ORIGINS). Empty => allow all (dev).
const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
  : [];

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Security headers.
app.use(helmet());

// CORS allowlist. Non-allowed origins receive HTTP 403.
// OPTIONS preflight is answered here so rate limiters never see it.
app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (corsOrigins.length === 0) {
    // Development: allow all origins.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
  }

  if (!origin || corsOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
  }

  // Origin not in allowlist -> blocked by CORS.
  return res.status(403).json(errorResponse(403, 'Not allowed by CORS'));
});

// Limit request body to 100KB.
app.use(express.json({ limit: '100kb' }));

// Structured request logging (pino-http). Logs method, url, statusCode,
// responseTime — never the request body or any email addresses.
app.use(
  pinoHttp({
    logger,
    redact: ['req.headers.x-api-key', 'req.headers.authorization'],
  })
);

// Optional API key middleware. Only enforced when API_KEY is set.
if (API_KEY) {
  app.use('/api', (req, res, next) => {
    const key = req.headers['x-api-key'];
    if (!key || key !== API_KEY) {
      return res.status(401).json(errorResponse(401, 'Invalid or missing API key.'));
    }
    next();
  });
}

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------

function rateLimitHandler(req, res) {
  res.status(429).json(errorResponse(429, 'Too many requests, please try again later.'));
}

const globalLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

// Stricter limit on the bulk endpoint.
const bulkLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: Math.max(1, Math.floor(RATE_LIMIT_MAX / 5)),
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

app.use(globalLimiter);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Standardized error response shape: { error: { code, message } }.
 */
function errorResponse(code, message) {
  return { error: { code, message } };
}

/**
 * Build per-item validation result for an item that is not a valid string.
 */
function invalidItemResult(item) {
  return {
    email: String(item ?? ''),
    status: 'invalid_syntax',
    reason: 'Email must be a non-empty string',
    checks: { syntax: false, disposable: false, mx: null },
    mailboxVerified: false,
  };
}

/**
 * Deduplicate emails case-insensitively, preserving first-seen order.
 * Returns { unique: string[], duplicatesRemoved: number }.
 */
function deduplicate(emails) {
  const seen = new Set();
  const unique = [];
  let duplicatesRemoved = 0;
  for (const email of emails) {
    const key = String(email).toLowerCase();
    if (seen.has(key)) {
      duplicatesRemoved += 1;
    } else {
      seen.add(key);
      unique.push(email);
    }
  }
  return { unique, duplicatesRemoved };
}

/**
 * Count results by status. Sum of byStatus counts equals `processed`.
 */
function buildSummary(results, submitted, duplicatesRemoved) {
  const processed = results.length;
  const byStatus = {};
  for (const r of results) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  }
  return {
    submitted,
    unique: processed,
    processed,
    duplicatesRemoved,
    total: processed,
    byStatus,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Single Email API Endpoint
app.post('/api/validate-single', async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string') {
      return res
        .status(400)
        .json(
          errorResponse(400, 'Email address is required and must be a string.')
        );
    }
    const validationResult = await validateEmail(email, {
      cache: domainCache,
    });
    // Log counts only — never the email address itself.
    logger.info(
      { status: 200, resultStatus: validationResult.status },
      'Single validation completed'
    );
    res.json(validationResult);
  } catch (error) {
    next(error);
  }
});

// Bulk Email API Endpoint (bounded concurrency, cached domain lookups)
app.post('/api/validate-bulk', bulkLimiter, async (req, res, next) => {
  try {
    const { emails } = req.body;

    // Validate that emails is an array.
    if (!Array.isArray(emails)) {
      return res
        .status(400)
        .json(
          errorResponse(
            400,
            '"emails" must be an array of email address strings.'
          )
        );
    }

    // Reject empty array.
    if (emails.length === 0) {
      return res
        .status(400)
        .json(errorResponse(400, '"emails" array must not be empty.'));
    }

    // Reject oversized batches — NEVER silently truncate.
    if (emails.length > MAX_BULK) {
      return res.status(400).json(
        errorResponse(
          400,
          `"emails" exceeds the maximum of ${MAX_BULK} addresses per request (submitted ${emails.length}).`
        )
      );
    }

    // Remove duplicates case-insensitively, but report them.
    const submitted = emails.length;
    const { unique, duplicatesRemoved } = deduplicate(emails);

    // Validate each item individually. Non-string / over-length items still
    // return a per-item invalid_syntax result rather than crashing the batch.
    const limit = pLimit(BULK_CONCURRENCY);
    const results = await Promise.all(
      unique.map((email) =>
        limit(async () => {
          if (typeof email !== 'string') {
            return invalidItemResult(email);
          }
          return validateEmail(email, { cache: domainCache });
        })
      )
    );

    const summary = buildSummary(results, submitted, duplicatesRemoved);

    // Log counts only — never email addresses.
    logger.info(
      {
        status: 200,
        submitted,
        processed: results.length,
        duplicatesRemoved,
        byStatus: summary.byStatus,
      },
      'Bulk validation completed'
    );

    res.json({ summary, results });
  } catch (error) {
    next(error);
  }
});

// Health check endpoint.
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Express error-handling middleware (standardized error shape).
app.use((err, req, res, next) => {
  logger.error(
    { err: err.message, status: err.statusCode || err.status || 500 },
    'Request error'
  );

  // Body-parser limit exceeded -> 413.
  if (
    err &&
    (err.type === 'entity.too large' ||
      err.status === 413 ||
      (err.message && /entity too large/i.test(err.message)))
  ) {
    return res
      .status(413)
      .json(
        errorResponse(413, 'Request entity too large. Body limit is 100KB.')
      );
  }

  const code = err.statusCode || err.status || 500;
  res.status(code).json(errorResponse(code, err.message || 'Internal server error'));
});

// ---------------------------------------------------------------------------
// Server startup + graceful shutdown
// ---------------------------------------------------------------------------

// Only start listening when not in test mode (allows supertest to use `app` directly).
if (process.env.NODE_ENV !== 'test') {
  const server = app.listen(PORT, () => {
    logger.info({ port: PORT }, 'Email Validator Server running');
  });

  // Sensible server timeouts.
  server.keepAliveTimeout = 5000;
  server.headersTimeout = 60000;
  server.timeout = 120000;

  const shutdown = (signal) => {
    logger.info({ signal }, 'Received shutdown signal, closing server...');
    server.close((err) => {
      if (err) {
        logger.error(err, 'Error during server shutdown');
        process.exit(1);
      }
      logger.info('Server closed');
      process.exit(0);
    });
    // Force exit if graceful close takes too long.
    setTimeout(() => {
      logger.warn('Forced shutdown after timeout');
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle unexpected errors to avoid silent crashes.
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: err.message }, 'Uncaught exception');
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason: String(reason) }, 'Unhandled rejection');
    process.exit(1);
  });
}

module.exports = { app };
