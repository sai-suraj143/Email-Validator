/**
 * In-memory TTL cache for domain-level DNS lookups.
 *
 * Two levels are intended:
 *  1. Per-request cache: a short-lived instance created per bulk request so the
 *     same domain isn't looked up repeatedly within one batch.
 *  2. Optional cross-request TTL cache (5 minutes by default) so repeated
 *     requests for the same domain skip DNS entirely.
 *
 * Entries expire after `ttlMs` and are lazily evicted on read.
 */

class DomainCache {
  constructor({ ttlMs = 5 * 60 * 1000 } = {}) {
    this.ttlMs = ttlMs;
    this.map = new Map(); // key -> { value, expiry }
  }

  _key(domain, recordType) {
    return `${recordType || 'mx'}:${String(domain).toLowerCase()}`;
  }

  get(domain, recordType) {
    const entry = this.map.get(this._key(domain, recordType));
    if (!entry) return undefined;
    if (Date.now() > entry.expiry) {
      this.map.delete(this._key(domain, recordType));
      return undefined;
    }
    return entry.value;
  }

  set(domain, value, recordType) {
    this.map.set(this._key(domain, recordType), {
      value,
      expiry: Date.now() + this.ttlMs,
    });
  }

  has(domain, recordType) {
    return this.get(domain, recordType) !== undefined;
  }

  clear() {
    this.map.clear();
  }

  size() {
    return this.map.size;
  }
}

module.exports = { DomainCache };
