/**
 * Evidence-based email validation.
 *
 * MX records only prove a domain accepts mail — they do NOT verify a
 * specific mailbox exists. Therefore this module never returns a status
 * claiming a mailbox is "Valid". The strongest honest claim is
 * `domain_accepts_mail` with `mailboxVerified: false`.
 *
 * `validateEmail(email, options)` accepts an optional `options` object:
 *   - cache: a DomainCache instance used to memoize per-domain DNS lookups.
 */

const validator = require('validator');
const dns = require('dns').promises;
const DISPOSABLE_DOMAINS = require('../data/disposableDomains');

// Configuration
const MAX_TOTAL_LENGTH = 254; // RFC 5321 limit
const MAX_LOCAL_PART_LENGTH = 64;
const DNS_TIMEOUT_MS = 5000;

/**
 * Normalize an email: trim whitespace and lowercase the domain part.
 * The local part is preserved as-is (case-sensitive per RFC).
 */
function normalizeEmail(email) {
  const trimmed = email.trim();
  const atIndex = trimmed.indexOf('@');
  if (atIndex === -1) return trimmed.toLowerCase();
  const local = trimmed.slice(0, atIndex);
  const domain = trimmed.slice(atIndex + 1).toLowerCase();
  return `${local}@${domain}`;
}

/**
 * Run a DNS promise with a hard timeout. On timeout the returned promise
 * rejects with an Error whose code is 'ETIMEOUT'.
 */
function withTimeout(promise, ms = DNS_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('DNS lookup timed out');
      err.code = 'ETIMEOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Resolve MX records for a domain with a timeout, using the cache when
 * provided. Returns { mx: boolean|null, code: string|null }.
 *   mx: true  -> MX records exist
 *   mx: false -> domain exists but no MX records (ENODATA / empty)
 *   mx: null  -> could not determine (not found / timeout / error)
 */
async function lookupMx(domain, cache) {
  const cacheKey = domain;
  if (cache && cache.has(cacheKey, 'mx')) {
    return cache.get(cacheKey, 'mx');
  }

  let result;
  try {
    const records = await withTimeout(dns.resolveMx(domain));
    if (Array.isArray(records) && records.length > 0) {
      result = { mx: true, code: null };
    } else {
      // Empty list: domain exists, no MX records.
      result = { mx: false, code: 'ENODATA' };
    }
  } catch (err) {
    const code = err && err.code ? err.code : 'UNKNOWN';
    // Domain does not exist at all.
    if (code === 'ENOTFOUND') {
      result = { mx: null, code: 'ENOTFOUND' };
    } else if (code === 'ENODATA') {
      // Domain exists but no MX of this type.
      result = { mx: false, code: 'ENODATA' };
    } else if (
      code === 'ETIMEOUT' ||
      code === 'ECONNREFUSED' ||
      code === 'ECONNRESET'
    ) {
      // Timeout or temporary failure -> not treated as invalid.
      result = { mx: null, code };
    } else {
      // Any other lookup failure -> treat as indeterminate DNS error.
      result = { mx: null, code: code || 'UNKNOWN' };
    }
  }

  if (cache) cache.set(cacheKey, result, 'mx');
  return result;
}

/**
 * Resolve A / AAAA records for a domain (fallback when no MX records).
 * Returns true if any address record exists (domain is reachable), null if
 * the lookup timed out / temporarily failed, false if domain not found.
 */
async function hasAddressRecords(domain, cache) {
  for (const rr of ['A', 'AAAA']) {
    const cacheKey = domain;
    if (cache && cache.has(cacheKey, rr)) {
      const cached = cache.get(cacheKey, rr);
      if (cached === null) return null;
      if (cached === true) return true;
      // cached false -> try next record type
      continue;
    }

    let found;
    try {
      const records = await withTimeout(dns.resolve(domain, rr));
      found = Array.isArray(records) && records.length > 0;
    } catch (err) {
      const code = err && err.code ? err.code : '';
      if (code === 'ENODATA') {
        // Domain exists but no record of this type; try next type.
        if (cache) cache.set(cacheKey, false, rr);
        continue;
      }
      if (code === 'ENOTFOUND') {
        if (cache) cache.set(cacheKey, false, rr);
        return false;
      }
      if (
        code === 'ETIMEOUT' ||
        code === 'ECONNREFUSED' ||
        code === 'ECONNRESET'
      ) {
        if (cache) cache.set(cacheKey, null, rr);
        return null;
      }
      if (cache) cache.set(cacheKey, false, rr);
      continue;
    }

    if (cache) cache.set(cacheKey, found, rr);
    if (found) return true;
  }
  return false;
}

/**
 * Check whether a domain (or any of its parent subdomains) is disposable.
 * e.g. `sub.mailinator.com` matches `mailinator.com`.
 */
function isDisposableDomain(domain) {
  if (!domain) return false;
  if (DISPOSABLE_DOMAINS.has(domain)) return true;
  // Check parent subdomains: a.b.c.com -> b.c.com, c.com
  let cursor = domain;
  let idx;
  while ((idx = cursor.indexOf('.')) !== -1) {
    cursor = cursor.slice(idx + 1);
    if (DISPOSABLE_DOMAINS.has(cursor)) return true;
  }
  return false;
}

/**
 * Base result object shared by every code path.
 */
function baseResult(email) {
  return {
    email,
    status: null,
    reason: '',
    checks: {
      syntax: false,
      disposable: false,
      mx: null,
    },
    mailboxVerified: false,
  };
}

/**
 * Validate a single email address.
 *
 * Returns an object shaped like:
 *   {
 *     email,                      // normalized email
 *     status,                     // invalid_syntax | disposable | no_mx_records |
 *                                 //   domain_not_found | dns_error | domain_accepts_mail
 *     reason,                     // human-readable reason
 *     checks: { syntax, disposable, mx: bool|null },
 *     mailboxVerified: false
 *   }
 */
async function validateEmail(email, options = {}) {
  const { cache } = options;

  // Non-string / empty input.
  if (!email || typeof email !== 'string') {
    const result = baseResult(String(email ?? ''));
    result.status = 'invalid_syntax';
    result.reason = 'Empty or non-string email input';
    return result;
  }

  const normalized = normalizeEmail(email);
  const result = baseResult(normalized);

  // --- 1. Syntax check ---
  // Enforce length limits first (validator.isEmail is lenient on length).
  if (normalized.length > MAX_TOTAL_LENGTH) {
    result.status = 'invalid_syntax';
    result.reason = `Email exceeds ${MAX_TOTAL_LENGTH} characters`;
    return result;
  }

  const [localPart] = normalized.split('@');
  if (!localPart || localPart.length > MAX_LOCAL_PART_LENGTH) {
    result.status = 'invalid_syntax';
    result.reason = `Local part exceeds ${MAX_LOCAL_PART_LENGTH} characters`;
    return result;
  }

  if (!validator.isEmail(normalized)) {
    result.status = 'invalid_syntax';
    result.reason = 'Invalid email syntax format';
    return result;
  }

  result.checks.syntax = true;

  const [, domain] = normalized.split('@');

  // --- 2. Disposable check (before DNS) ---
  if (isDisposableDomain(domain)) {
    result.checks.disposable = true;
    result.status = 'disposable';
    result.reason = 'Disposable / temporary email provider';
    return result;
  }

  // --- 3. DNS MX lookup (with 5s timeout) ---
  const mx = await lookupMx(domain, cache);

  // DNS error / temporary failure / not found -> do not claim invalid.
  if (mx.mx === null) {
    if (mx.code === 'ENOTFOUND') {
      result.status = 'domain_not_found';
      result.reason = 'Domain does not exist (NXDOMAIN)';
    } else {
      result.status = 'dns_error';
      result.reason = `DNS lookup failed (${mx.code || 'temporary failure'})`;
    }
    return result;
  }

  // MX records exist -> domain accepts mail, mailbox NOT verified.
  if (mx.mx === true) {
    result.checks.mx = true;
    result.status = 'domain_accepts_mail';
    result.reason = 'Domain has MX records; accepts mail but mailbox not verified';
    return result;
  }

  // mx === false : domain exists but no MX records. Fall back to A/AAAA.
  result.checks.mx = false;
  const addressResult = await hasAddressRecords(domain, cache);

  if (addressResult === null) {
    // A/AAAA lookup timed out / temporarily failed.
    result.status = 'dns_error';
    result.reason = 'DNS A/AAAA lookup timed out or temporarily failed';
    return result;
  }

  if (addressResult === true) {
    // Domain exists via address records; mail could route there.
    result.status = 'no_mx_records';
    result.reason = 'Domain exists (A/AAAA records) but has no MX records';
    return result;
  }

  // No MX and no address records -> domain not found.
  result.status = 'domain_not_found';
  result.reason = 'Domain does not exist (no MX or A/AAAA records)';
  return result;
}

module.exports = { validateEmail };
