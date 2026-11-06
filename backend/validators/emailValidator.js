/**
 * Evidence-based email validation.
 *
 * MX records only prove a domain accepts mail — they do NOT verify a
 * specific mailbox exists. Therefore this module never returns a status
 * claiming a mailbox is "Valid". The strongest honest claim is
 * `domain_accepts_mail` with `mailboxVerified: false`.
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
 * Resolve MX records for a domain with a timeout.
 * Returns { mx: boolean|null, code: string|null }.
 *   mx: true  -> MX records exist
 *   mx: false -> domain exists but no MX records (ENODATA / empty)
 *   mx: null  -> could not determine (not found / timeout / error)
 */
async function lookupMx(domain) {
  try {
    const records = await withTimeout(dns.resolveMx(domain));
    if (Array.isArray(records) && records.length > 0) {
      return { mx: true, code: null };
    }
    // Empty list: domain exists, no MX records.
    return { mx: false, code: 'ENODATA' };
  } catch (err) {
    const code = err && err.code ? err.code : 'UNKNOWN';
    // Domain does not exist at all.
    if (code === 'ENOTFOUND') {
      return { mx: null, code: 'ENOTFOUND' };
    }
    // Domain exists but no MX of this type.
    if (code === 'ENODATA') {
      return { mx: false, code: 'ENODATA' };
    }
    // Timeout or temporary failure -> not treated as invalid.
    if (code === 'ETIMEOUT' || code === 'ECONNREFUSED' || code === 'ECONNRESET') {
      return { mx: null, code: code };
    }
    // Any other lookup failure -> treat as indeterminate DNS error.
    return { mx: null, code: code || 'UNKNOWN' };
  }
}

/**
 * Resolve A / AAAA records for a domain (fallback when no MX records).
 * Returns true if any address record exists (domain is reachable).
 */
async function hasAddressRecords(domain) {
  for (const rr of ['A', 'AAAA']) {
    try {
      const records = await withTimeout(dns.resolve(domain, rr));
      if (Array.isArray(records) && records.length > 0) {
        return true;
      }
    } catch (err) {
      const code = err && err.code ? err.code : '';
      // ENODATA means domain exists but no record of this type; try next type.
      if (code === 'ENODATA') continue;
      // ENOTFOUND means domain doesn't exist.
      if (code === 'ENOTFOUND') return false;
      // Timeout / temporary failure -> indeterminate.
      if (code === 'ETIMEOUT' || code === 'ECONNREFUSED' || code === 'ECONNRESET') {
        return null;
      }
    }
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
async function validateEmail(email) {
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
  const mx = await lookupMx(domain);

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
  const addressResult = await hasAddressRecords(domain);

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
