/**
 * Frontend tests for App.jsx using React Testing Library.
 *
 * axios is mocked so no real API calls are made during tests.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import userEvent from '@testing-library/user-event';
import App from '../App';

// Mock axios so no network is hit.
jest.mock('axios', () => ({
  post: jest.fn(),
}));

const axios = require('axios');

// Mock clipboard API.
navigator.clipboard = {
  writeText: jest.fn().mockResolvedValue(undefined),
};

// Mock URL.createObjectURL and Blob for CSV export.
global.URL.createObjectURL = jest.fn(() => 'mocked-url');
global.URL.revokeObjectURL = jest.fn();
const originalBlob = global.Blob;
let capturedBlobText = '';
global.Blob = class MockBlob {
  constructor(parts, options) {
    capturedBlobText = Array.isArray(parts) ? parts.join('') : String(parts);
    this.parts = parts;
    this.options = options;
  }
};

afterEach(() => {
  jest.clearAllMocks();
  capturedBlobText = '';
});

const API_BASE = 'http://localhost:5000/api';

function mockAxiosResponse(data, status = 200) {
  axios.post.mockResolvedValueOnce({ status, data });
}

function mockAxiosError(status, message) {
  axios.post.mockRejectedValueOnce({
    response: { status, data: { error: { code: status, message } } },
  });
}

describe('status badge rendering', () => {
  test('displays domain_accepts_mail badge with tooltip', async () => {
    mockAxiosResponse({
      email: 'user@gmail.com',
      status: 'domain_accepts_mail',
      reason: 'Domain has MX records; accepts mail but mailbox not verified',
      checks: { syntax: true, disposable: false, mx: true },
      mailboxVerified: false,
    });

    render(<App />);
    fireEvent.change(screen.getByLabelText(/enter email address/i), {
      target: { value: 'user@gmail.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /verify email/i }));

    await waitFor(() => {
      expect(screen.getByText('Domain accepts mail')).toBeInTheDocument();
    });
    expect(screen.getByText('Mailbox existence not verified')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveClass('accepts');
  });

  test('displays invalid_syntax badge in red', async () => {
    mockAxiosResponse({
      email: 'bad@@email',
      status: 'invalid_syntax',
      reason: 'Invalid email syntax format',
      checks: { syntax: false, disposable: false, mx: null },
      mailboxVerified: false,
    });

    render(<App />);
    fireEvent.change(screen.getByLabelText(/enter email address/i), {
      target: { value: 'bad@@email' },
    });
    fireEvent.click(screen.getByRole('button', { name: /verify email/i }));

    await waitFor(() => {
      expect(screen.getByText('Invalid syntax')).toBeInTheDocument();
    });
    expect(screen.getByRole('status')).toHaveClass('invalid');
  });

  test('displays disposable badge in orange', async () => {
    mockAxiosResponse({
      email: 'test@mailinator.com',
      status: 'disposable',
      reason: 'Disposable / temporary email provider',
      checks: { syntax: true, disposable: true, mx: null },
      mailboxVerified: false,
    });

    render(<App />);
    fireEvent.change(screen.getByLabelText(/enter email address/i), {
      target: { value: 'test@mailinator.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /verify email/i }));

    await waitFor(() => {
      expect(screen.getByText('Disposable domain')).toBeInTheDocument();
    });
    expect(screen.getByRole('status')).toHaveClass('disposable');
  });

  test('displays dns_error badge in gray', async () => {
    mockAxiosResponse({
      email: 'user@slow.example.com',
      status: 'dns_error',
      reason: 'DNS lookup failed (ETIMEOUT)',
      checks: { syntax: true, disposable: false, mx: null },
      mailboxVerified: false,
    });

    render(<App />);
    fireEvent.change(screen.getByLabelText(/enter email address/i), {
      target: { value: 'user@slow.example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /verify email/i }));

    await waitFor(() => {
      expect(screen.getByText('Could not verify (retry)')).toBeInTheDocument();
    });
    expect(screen.getByRole('status')).toHaveClass('dns_error');
  });

  test('never implies mailbox is confirmed', async () => {
    mockAxiosResponse({
      email: 'user@gmail.com',
      status: 'domain_accepts_mail',
      reason: 'Domain has MX records; accepts mail but mailbox not verified',
      checks: { syntax: true, disposable: false, mx: true },
      mailboxVerified: false,
    });

    render(<App />);
    fireEvent.change(screen.getByLabelText(/enter email address/i), {
      target: { value: 'user@gmail.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /verify email/i }));

    await waitFor(() => {
      expect(screen.getByText(/mailbox verified/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/no — not verifiable from mx records/i)).toBeInTheDocument();
    expect(screen.queryByText(/valid mailbox/i)).not.toBeInTheDocument();
    // The info note uses "confirmed mailbox" but that's a limitation statement,
    // not a claim that the mailbox is confirmed. Verify no affirmative confirmation.
    expect(screen.queryByText(/mailbox is confirmed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/confirmed valid/i)).not.toBeInTheDocument();
  });
});

describe('bulk counter and limit', () => {
  beforeEach(() => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /bulk check/i }));
  });

  test('shows live counter while typing', async () => {
    const textarea = screen.getByLabelText(/paste email list/i);

    fireEvent.change(textarea, { target: { value: 'a@b.com\nc@d.com' } });
    expect(screen.getByText(/2 \/ 100 emails/)).toBeInTheDocument();
  });

  test('parses newline, comma, and semicolon separators', async () => {
    const textarea = screen.getByLabelText(/paste email list/i);

    fireEvent.change(textarea, {
      target: { value: 'a@b.com, c@d.com; e@f.com' },
    });
    expect(screen.getByText(/3 \/ 100 emails/)).toBeInTheDocument();
  });

  test('disables submit button when over the 100 limit', async () => {
    const textarea = screen.getByLabelText(/paste email list/i);
    const overLimitInput = Array.from({ length: 101 }, (_, i) =>
      `user${i}@gmail.com`
    ).join('\n');

    fireEvent.change(textarea, { target: { value: overLimitInput } });
    expect(screen.getByText(/101 \/ 100 emails/)).toBeInTheDocument();

    const submitButton = screen.getByRole('button', { name: /verify all emails/i });
    expect(submitButton).toBeDisabled();
  });

  test('enables submit button when under the limit', async () => {
    const textarea = screen.getByLabelText(/paste email list/i);

    fireEvent.change(textarea, { target: { value: 'a@b.com\nc@d.com' } });
    const submitButton = screen.getByRole('button', { name: /verify all emails/i });
    expect(submitButton).toBeEnabled();
  });

  test('disables submit button when bulk input is empty', async () => {
    const textarea = screen.getByLabelText(/paste email list/i);
    fireEvent.change(textarea, { target: { value: '' } });

    const submitButton = screen.getByRole('button', { name: /verify all emails/i });
    expect(submitButton).toBeDisabled();
  });
});

describe('CSV export escaping and formula neutralization', () => {
  beforeEach(() => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /bulk check/i }));
  });

  test('neutralizes formula-injection cells starting with = + - @', async () => {
    mockAxiosResponse({
      summary: {
        submitted: 4,
        unique: 4,
        processed: 4,
        duplicatesRemoved: 0,
        total: 4,
        byStatus: { domain_accepts_mail: 4 },
      },
      results: [
        {
          email: '=HYPERLINK("x")',
          status: 'domain_accepts_mail',
          reason: 'Domain has MX records',
          mailboxVerified: false,
          checks: { syntax: true, disposable: false, mx: true },
        },
        {
          email: '+cmd|/c calc!A0',
          status: 'invalid_syntax',
          reason: 'Bad',
          mailboxVerified: false,
          checks: { syntax: false, disposable: false, mx: null },
        },
        {
          email: '-123',
          status: 'domain_not_found',
          reason: 'NXDOMAIN',
          mailboxVerified: false,
          checks: { syntax: true, disposable: false, mx: false },
        },
        {
          email: '@attack',
          status: 'dns_error',
          reason: 'Timeout',
          mailboxVerified: false,
          checks: { syntax: true, disposable: false, mx: null },
        },
        {
          email: 'normal@example.com',
          status: 'domain_accepts_mail',
          reason: 'OK',
          mailboxVerified: false,
          checks: { syntax: true, disposable: false, mx: true },
        },
      ],
    });

    fireEvent.change(screen.getByLabelText(/paste email list/i), {
      target: { value: 'a@b.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /verify all emails/i }));

    await waitFor(() => {
      expect(screen.getByText('📥 Export CSV')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('📥 Export CSV'));

    // The blob should contain single-quote-prefixed formula cells.
    // papaparse quotes cells containing special chars (doubling inner quotes).
    expect(capturedBlobText).toContain("'=HYPERLINK");
    expect(capturedBlobText).toContain("'+cmd|/c calc!A0");
    expect(capturedBlobText).toContain("'-123");
    expect(capturedBlobText).toContain("'@attack");
    // Normal cells are untouched.
    expect(capturedBlobText).toContain('normal@example.com');
  });

  test('includes required CSV columns', async () => {
    mockAxiosResponse({
      summary: {
        submitted: 1,
        unique: 1,
        processed: 1,
        duplicatesRemoved: 0,
        total: 1,
        byStatus: { domain_accepts_mail: 1 },
      },
      results: [
        {
          email: 'user@gmail.com',
          status: 'domain_accepts_mail',
          reason: 'Domain has MX records',
          mailboxVerified: false,
          checks: { syntax: true, disposable: false, mx: true },
        },
      ],
    });

    fireEvent.change(screen.getByLabelText(/paste email list/i), {
      target: { value: 'a@b.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /verify all emails/i }));

    await waitFor(() => {
      expect(screen.getByText('📥 Export CSV')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('📥 Export CSV'));

    expect(capturedBlobText).toContain('email,status,reason,mailboxVerified');
  });
});

describe('error banner on API failure', () => {
  test('shows error banner when single validation fails', async () => {
    mockAxiosError(400, 'Email address is required and must be a string.');

    render(<App />);
    fireEvent.change(screen.getByLabelText(/enter email address/i), {
      target: { value: 'user@gmail.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /verify email/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      /email address is required/i
    );
  });

  test('shows error banner when bulk validation fails', async () => {
    mockAxiosError(400, '"emails" exceeds the maximum of 100 addresses');

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /bulk check/i }));
    const textarea = screen.getByLabelText(/paste email list/i);
    fireEvent.change(textarea, { target: { value: 'a@b.com' } });
    fireEvent.click(screen.getByRole('button', { name: /verify all emails/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });

  test('error banner can be dismissed', async () => {
    mockAxiosError(500, 'Something went wrong');

    render(<App />);
    fireEvent.change(screen.getByLabelText(/enter email address/i), {
      target: { value: 'user@gmail.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /verify email/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /dismiss error/i }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('loading state', () => {
  test('disables buttons while loading', async () => {
    // Resolve after a short delay to simulate loading.
    axios.post.mockImplementationOnce(() =>
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              status: 200,
              data: {
                email: 'user@gmail.com',
                status: 'domain_accepts_mail',
                reason: 'Domain has MX records; accepts mail but mailbox not verified',
                checks: { syntax: true, disposable: false, mx: true },
                mailboxVerified: false,
              },
            }),
          100
        )
      )
    );

    render(<App />);
    fireEvent.change(screen.getByLabelText(/enter email address/i), {
      target: { value: 'user@gmail.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /verify email/i }));

    // Should be disabled immediately (loading state).
    expect(screen.getByRole('button', { name: /validating/i })).toBeDisabled();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /verify email/i })).toBeEnabled();
    });
  });
});
