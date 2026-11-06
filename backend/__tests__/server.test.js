/**
 * Integration tests for the Express API (backend/server.js).
 *
 * DNS is mocked via jest.mock('dns') so no network is ever hit.
 * The server is NOT started (app.listen is skipped in NODE_ENV=test);
 * supertest drives the `app` object directly.
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

// Set CORS allowlist before requiring the server module.
process.env.CORS_ORIGINS = 'http://localhost:3000';
process.env.MAX_BULK = '100';
process.env.NODE_ENV = 'test';

const dns = require('dns');
const { app } = require('../server');
const request = require('supertest');

function setMx(records) {
  dns.promises.resolveMx.mockResolvedValue(records);
}
function setMxError(code) {
  const err = new Error(`DNS error: ${code}`);
  err.code = code;
  dns.promises.resolveMx.mockRejectedValue(err);
}
function setAddress(records) {
  dns.promises.resolve.mockResolvedValue(records);
}
function setAddressError(code) {
  const err = new Error(`DNS error: ${code}`);
  err.code = code;
  dns.promises.resolve.mockRejectedValue(err);
}

beforeEach(() => {
  jest.clearAllMocks();
  setMxError('ENOTFOUND');
  setAddressError('ENOTFOUND');
});

describe('GET /api/health', () => {
  test('returns status ok with uptime', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Origin', 'http://localhost:3000');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.uptime).toBe('number');
  });
});

describe('POST /api/validate-single', () => {
  test('domain_accepts_mail for gmail.com (MX found)', async () => {
    setMx([{ priority: 10, exchange: 'mx.gmail.com' }]);
    const res = await request(app)
      .post('/api/validate-single')
      .set('Origin', 'http://localhost:3000')
      .send({ email: 'fakeuser123@gmail.com' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('domain_accepts_mail');
    expect(res.body.mailboxVerified).toBe(false);
    expect(res.body.checks.mx).toBe(true);
    expect(res.body.checks.syntax).toBe(true);
  });

  test('never returns "Valid" status', async () => {
    setMx([{ priority: 10, exchange: 'mx.gmail.com' }]);
    const res = await request(app)
      .post('/api/validate-single')
      .set('Origin', 'http://localhost:3000')
      .send({ email: 'user@gmail.com' });
    expect(res.body.status).not.toBe('Valid');
  });

  test('disposable domain returns disposable', async () => {
    const res = await request(app)
      .post('/api/validate-single')
      .set('Origin', 'http://localhost:3000')
      .send({ email: 'test@mailinator.com' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('disposable');
    expect(res.body.checks.disposable).toBe(true);
    expect(res.body.mailboxVerified).toBe(false);
  });

  test('bad@@email returns invalid_syntax', async () => {
    const res = await request(app)
      .post('/api/validate-single')
      .set('Origin', 'http://localhost:3000')
      .send({ email: 'bad@@email' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('invalid_syntax');
  });

  test('nonexistent domain returns domain_not_found', async () => {
    const res = await request(app)
      .post('/api/validate-single')
      .set('Origin', 'http://localhost:3000')
      .send({ email: 'abc@nonexistent-domain-xyz123.com' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('domain_not_found');
  });

  test('DNS timeout returns dns_error, not invalid', async () => {
    dns.promises.resolveMx.mockRejectedValue(
      Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })
    );
    const res = await request(app)
      .post('/api/validate-single')
      .set('Origin', 'http://localhost:3000')
      .send({ email: 'user@slow.example.com' });
    expect(res.body.status).toBe('dns_error');
  });

  test('missing email returns 400 with standard error JSON', async () => {
    const res = await request(app)
      .post('/api/validate-single')
      .set('Origin', 'http://localhost:3000')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 400,
      message: expect.stringContaining('required'),
    });
  });
});

describe('POST /api/validate-bulk', () => {
  test('single valid email returns correct summary', async () => {
    setMx([{ priority: 10, exchange: 'mx.gmail.com' }]);
    const res = await request(app)
      .post('/api/validate-bulk')
      .set('Origin', 'http://localhost:3000')
      .send({ emails: ['fakeuser123@gmail.com'] });
    expect(res.status).toBe(200);
    expect(res.body.summary.submitted).toBe(1);
    expect(res.body.summary.processed).toBe(1);
    expect(res.body.summary.duplicatesRemoved).toBe(0);
    expect(res.body.summary.byStatus.domain_accepts_mail).toBe(1);
    expect(res.body.results.length).toBe(1);
  });

  test('empty array returns 400', async () => {
    const res = await request(app)
      .post('/api/validate-bulk')
      .set('Origin', 'http://localhost:3000')
      .send({ emails: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(400);
  });

  test('non-array emails returns 400', async () => {
    const res = await request(app)
      .post('/api/validate-bulk')
      .set('Origin', 'http://localhost:3000')
      .send({ emails: 'not-an-array' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(400);
  });

  test('101 emails returns 400 and nothing is dropped', async () => {
    const emails = Array.from({ length: 101 }, (_, i) => `user${i}@gmail.com`);
    setMx([{ priority: 10, exchange: 'mx.gmail.com' }]);
    const res = await request(app)
      .post('/api/validate-bulk')
      .set('Origin', 'http://localhost:3000')
      .send({ emails });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(400);
    expect(res.body.error.message).toContain('100');
    // Ensure no results are silently returned.
    expect(res.body.results).toBeUndefined();
  });

  test('exactly 100 emails is accepted', async () => {
    const emails = Array.from({ length: 100 }, (_, i) => `user${i}@gmail.com`);
    setMx([{ priority: 10, exchange: 'mx.gmail.com' }]);
    const res = await request(app)
      .post('/api/validate-bulk')
      .set('Origin', 'http://localhost:3000')
      .send({ emails });
    expect(res.status).toBe(200);
    expect(res.body.summary.submitted).toBe(100);
  });

  test('duplicates are removed and reported', async () => {
    setMx([{ priority: 10, exchange: 'mx.gmail.com' }]);
    const res = await request(app)
      .post('/api/validate-bulk')
      .set('Origin', 'http://localhost:3000')
      .send({
        emails: [
          'User@Gmail.com',
          'user@gmail.com',
          'USER@GMAIL.COM',
          'test@mailinator.com',
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.summary.submitted).toBe(4);
    expect(res.body.summary.unique).toBe(2);
    expect(res.body.summary.processed).toBe(2);
    expect(res.body.summary.duplicatesRemoved).toBe(2);
  });

  test('summary byStatus counts add up to processed', async () => {
    setMx([{ priority: 10, exchange: 'mx.gmail.com' }]);
    const res = await request(app)
      .post('/api/validate-bulk')
      .set('Origin', 'http://localhost:3000')
      .send({
        emails: [
          'a@gmail.com',
          'b@mailinator.com',
          'bad@@email',
          'c@nonexistent-domain-xyz123.com',
        ],
      });
    expect(res.status).toBe(200);
    const { byStatus, processed } = res.body.summary;
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
    expect(total).toBe(processed);
  });

  test('non-string items return per-item invalid_syntax, no crash', async () => {
    const res = await request(app)
      .post('/api/validate-bulk')
      .set('Origin', 'http://localhost:3000')
      .send({ emails: ['valid@gmail.com', 123, null, true] });
    expect(res.status).toBe(200);
    expect(res.body.results.length).toBe(4);
    expect(res.body.results[1].status).toBe('invalid_syntax');
    expect(res.body.results[2].status).toBe('invalid_syntax');
    expect(res.body.results[3].status).toBe('invalid_syntax');
  });
});

describe('error response format', () => {
  test('400 errors use { error: { code, message } } shape', async () => {
    const res = await request(app)
      .post('/api/validate-single')
      .set('Origin', 'http://localhost:3000')
      .send({ email: 123 });
    expect(res.status).toBe(400);
    expect(res.body.error).toHaveProperty('code', 400);
    expect(res.body.error).toHaveProperty('message');
    expect(typeof res.body.error.message).toBe('string');
  });
});

describe('CORS allowlist', () => {
  test('allowed origin is accepted', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Origin', 'http://localhost:3000');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(
      'http://localhost:3000'
    );
  });

  test('non-allowed origin is blocked with 403', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Origin', 'http://evil.com');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(403);
  });

  test('OPTIONS preflight for allowed origin returns 204', async () => {
    const res = await request(app)
      .options('/api/validate-single')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(204);
  });
});
