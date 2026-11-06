/**
 * Unit tests for validateEmail (backend/validators/emailValidator.js).
 *
 * DNS is mocked via jest.mock('dns') so no network is ever hit.
 */

jest.mock('dns', () => {
  const actual = jest.requireActual('dns');
  return {
    ...actual,
    promises: {
      resolveMx: jest.fn(),
      resolve: jest.fn(),
    },
  };
});

const dns = require('dns');
const { validateEmail } = require('../validators/emailValidator');

// Helpers to control the mocked DNS responses.
function setMx(records) {
  dns.promises.resolveMx.mockResolvedValue(records);
}
function setMxError(code) {
  const err = new Error(`DNS error: ${code}`);
  err.code = code;
  dns.promises.resolveMx.mockRejectedValue(err);
}
function setMxTimeout() {
  dns.promises.resolveMx.mockRejectedValue(
    Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })
  );
}
function setAddress(records) {
  dns.promises.resolve.mockResolvedValue(records);
}
function setAddressError(code) {
  const err = new Error(`DNS error: ${code}`);
  err.code = code;
  dns.promises.resolve.mockRejectedValue(err);
}
function setAddressTimeout() {
  dns.promises.resolve.mockRejectedValue(
    Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: no DNS records (simulates NXDOMAIN for MX and A lookups).
  setMxError('ENOTFOUND');
  setAddressError('ENOTFOUND');
});

describe('validateEmail - syntax', () => {
  test('empty input returns invalid_syntax', async () => {
    const res = await validateEmail('');
    expect(res.status).toBe('invalid_syntax');
    expect(res.mailboxVerified).toBe(false);
    expect(res.checks.syntax).toBe(false);
  });

  test('non-string input returns invalid_syntax', async () => {
    const res = await validateEmail(null);
    expect(res.status).toBe('invalid_syntax');
    expect(res.mailboxVerified).toBe(false);
  });

  test('missing @ returns invalid_syntax', async () => {
    const res = await validateEmail('noatsign');
    expect(res.status).toBe('invalid_syntax');
  });

  test('double @ returns invalid_syntax', async () => {
    const res = await validateEmail('bad@@email');
    expect(res.status).toBe('invalid_syntax');
    expect(res.reason).toBe('Invalid email syntax format');
  });

  test('local part too long (>64) returns invalid_syntax', async () => {
    const local = 'a'.repeat(65);
    const res = await validateEmail(`${local}@gmail.com`);
    expect(res.status).toBe('invalid_syntax');
    expect(res.reason).toContain('64');
  });

  test('total length too long (>254) returns invalid_syntax', async () => {
    const domain = 'b'.repeat(250);
    const res = await validateEmail(`a@${domain}.com`);
    expect(res.status).toBe('invalid_syntax');
    expect(res.reason).toContain('254');
  });

  test('no TLD returns invalid_syntax', async () => {
    const res = await validateEmail('user@domain');
    expect(res.status).toBe('invalid_syntax');
  });
});

describe('validateEmail - disposable', () => {
  beforeEach(() => {
    // DNS won't be reached for disposable domains (checked before DNS).
    dns.promises.resolveMx.mockClear();
    dns.promises.resolve.mockClear();
  });

  test('known disposable domain returns disposable', async () => {
    const res = await validateEmail('test@mailinator.com');
    expect(res.status).toBe('disposable');
    expect(res.checks.disposable).toBe(true);
    expect(res.mailboxVerified).toBe(false);
    expect(dns.promises.resolveMx).not.toHaveBeenCalled();
  });

  test('subdomain of disposable domain returns disposable', async () => {
    const res = await validateEmail('user@sub.mailinator.com');
    expect(res.status).toBe('disposable');
    expect(res.checks.disposable).toBe(true);
    expect(dns.promises.resolveMx).not.toHaveBeenCalled();
  });

  test('deeply nested disposable subdomain returns disposable', async () => {
    const res = await validateEmail('a@b.c.mailinator.com');
    expect(res.status).toBe('disposable');
  });

  test('non-disposable domain proceeds to DNS check', async () => {
    setMx([{ priority: 10, exchange: 'mx.example.com' }]);
    const res = await validateEmail('user@example.com');
    expect(res.status).toBe('domain_accepts_mail');
    expect(res.checks.disposable).toBe(false);
    expect(dns.promises.resolveMx).toHaveBeenCalledWith('example.com');
  });
});

describe('validateEmail - MX found', () => {
  test('MX records present returns domain_accepts_mail', async () => {
    setMx([{ priority: 10, exchange: 'mx.gmail.com' }]);
    const res = await validateEmail('fakeuser123@gmail.com');
    expect(res.status).toBe('domain_accepts_mail');
    expect(res.checks.mx).toBe(true);
    expect(res.mailboxVerified).toBe(false);
    expect(res.reason).toContain('MX records');
    expect(res.reason).toContain('not verified');
  });

  test('label never claims mailbox is valid', async () => {
    setMx([{ priority: 5, exchange: 'mail.example.com' }]);
    const res = await validateEmail('user@example.com');
    expect(res.status).not.toBe('Valid');
    expect(res.status).toBe('domain_accepts_mail');
    expect(res.mailboxVerified).toBe(false);
  });
});

describe('validateEmail - no MX records', () => {
  beforeEach(() => {
    // MX lookup returns empty array -> domain exists, no MX.
    setMx([]);
  });

  test('no MX but has A record returns no_mx_records', async () => {
    setAddress([{ address: '93.184.216.34' }]);
    const res = await validateEmail('user@example.com');
    expect(res.status).toBe('no_mx_records');
    expect(res.checks.mx).toBe(false);
  });

  test('no MX and no address records returns domain_not_found', async () => {
    setAddressError('ENOTFOUND');
    const res = await validateEmail('user@example.com');
    expect(res.status).toBe('domain_not_found');
    expect(res.checks.mx).toBe(false);
  });

  test('no MX and A lookup times out returns dns_error', async () => {
    setAddressTimeout();
    const res = await validateEmail('user@example.com');
    expect(res.status).toBe('dns_error');
  });
});

describe('validateEmail - NXDOMAIN / domain not found', () => {
  test('MX ENOTFOUND and A ENOTFOUND returns domain_not_found', async () => {
    setMxError('ENOTFOUND');
    setAddressError('ENOTFOUND');
    const res = await validateEmail('abc@nonexistent-domain-xyz123.com');
    expect(res.status).toBe('domain_not_found');
    expect(res.checks.mx).toBe(null);
  });
});

describe('validateEmail - DNS timeout / temporary failure', () => {
  test('MX timeout returns dns_error (never invalid)', async () => {
    setMxTimeout();
    const res = await validateEmail('user@slow.example.com');
    expect(res.status).toBe('dns_error');
    expect(res.checks.mx).toBe(null);
  });

  test('MX ECONNREFUSED returns dns_error', async () => {
    setMxError('ECONNREFUSED');
    const res = await validateEmail('user@example.com');
    expect(res.status).toBe('dns_error');
  });

  test('A/AAAA timeout after no MX returns dns_error', async () => {
    setMx([]);
    setAddressTimeout();
    const res = await validateEmail('user@example.com');
    expect(res.status).toBe('dns_error');
  });
});

describe('validateEmail - result shape', () => {
  test('every result has required fields', async () => {
    setMx([{ priority: 10, exchange: 'mx.example.com' }]);
    const res = await validateEmail('user@example.com');
    expect(res).toMatchObject({
      email: expect.any(String),
      status: expect.any(String),
      reason: expect.any(String),
      mailboxVerified: false,
      checks: {
        syntax: expect.any(Boolean),
        disposable: expect.any(Boolean),
        mx: expect.any(Boolean || null), // eslint-disable-line no-invalid-this
      },
    });
  });

  test('email is normalized (domain lowercased)', async () => {
    setMx([{ priority: 10, exchange: 'mx.example.com' }]);
    const res = await validateEmail('User@Example.COM');
    expect(res.email).toBe('User@example.com');
  });
});
