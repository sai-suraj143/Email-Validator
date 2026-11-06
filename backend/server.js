const express = require('express');
const cors = require('cors');
const pLimit = require('p-limit').default;

const { validateEmail } = require('./validators/emailValidator');
const { DomainCache } = require('./cache/domainCache');

const app = express();
const PORT = process.env.PORT || 5000;

// Configuration
const MAX_BULK = parseInt(process.env.MAX_BULK, 10) || 100;
const BULK_CONCURRENCY = parseInt(process.env.BULK_CONCURRENCY, 10) || 10;
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS, 10) || 5 * 60 * 1000; // 5 minutes

// Cross-request TTL cache for domain lookups (optional, 5 minutes by default).
const domainCache = new DomainCache({ ttlMs: CACHE_TTL_MS });

app.use(cors());
// Task 1: limit request body to 100KB.
app.use(express.json({ limit: '100kb' }));

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

// Single Email API Endpoint
app.post('/api/validate-single', async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string') {
      return res
        .status(400)
        .json(errorResponse(400, 'Email address is required and must be a string.'));
    }
    const validationResult = await validateEmail(email, { cache: domainCache });
    res.json(validationResult);
  } catch (error) {
    next(error);
  }
});

// Bulk Email API Endpoint (bounded concurrency, cached domain lookups)
app.post('/api/validate-bulk', async (req, res, next) => {
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
  res.status(code).json(
    errorResponse(code, err.message || 'Internal server error')
  );
});

app.listen(PORT, () => {
  console.log(`Email Validator Server running on http://localhost:${PORT}`);
});
