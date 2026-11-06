import React, { useState, useCallback, useEffect, useMemo } from 'react';
import axios from 'axios';
import { unparse } from 'papaparse';
import './App.css';

const API_BASE_URL =
  (process.env.REACT_APP_API_URL && process.env.REACT_APP_API_URL.trim()) ||
  'http://localhost:5000/api';

// Plain-language labels + colors for the new evidence-based statuses.
// None of these labels imply that an individual mailbox has been confirmed.
const STATUS_CONFIG = {
  domain_accepts_mail: {
    label: 'Domain accepts mail',
    variant: 'accepts',
    tooltip: 'Mailbox existence not verified',
  },
  invalid_syntax: { label: 'Invalid syntax', variant: 'invalid' },
  domain_not_found: { label: 'Domain not found', variant: 'invalid' },
  no_mx_records: { label: 'No MX records', variant: 'invalid' },
  disposable: { label: 'Disposable domain', variant: 'disposable' },
  dns_error: { label: 'Could not verify (retry)', variant: 'dns_error' },
};

const MAX_BULK = 100;

function statusLabel(status) {
  return STATUS_CONFIG[status]?.label || status;
}

function statusVariant(status) {
  return STATUS_CONFIG[status]?.variant || 'invalid';
}

function isAcceptsMail(status) {
  return status === 'domain_accepts_mail';
}

function isInvalid(status) {
  return [
    'invalid_syntax',
    'domain_not_found',
    'no_mx_records',
  ].includes(status);
}

function isDisposable(status) {
  return status === 'disposable';
}

function isUnverified(status) {
  return status === 'dns_error';
}

function parseBulkInput(input) {
  return input
    .split(/[\n,;]+/)
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
}

// Neutralize formula-injection cells (CSV: =, +, -, @, tab, CR).
function sanitizeCell(value) {
  const string = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(string)) {
    return `'${string}`;
  }
  return string;
}

function App() {
  const [activeTab, setActiveTab] = useState('single');
  const [filterTab, setFilterTab] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');

  const [singleEmail, setSingleEmail] = useState('');
  const [bulkInput, setBulkInput] = useState('');
  const [singleResult, setSingleResult] = useState(null);
  const [bulkResults, setBulkResults] = useState(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(null);

  const bulkEmails = useMemo(() => parseBulkInput(bulkInput), [bulkInput]);
  const overLimit = bulkEmails.length > MAX_BULK;

  // Clear transient UI state when switching tabs.
  useEffect(() => {
    setError(null);
    setCopied(null);
  }, [activeTab]);

  const clearError = () => setError(null);

  const setErrorWithDetail = (err, fallback) => {
    if (err && err.response && err.response.status >= 400 && err.response.status < 500) {
      const msg =
        (err.response.data && err.response.data.error && err.response.data.error.message) ||
        err.response.data ||
        `Request failed (${err.response.status}).`;
      setError(typeof msg === 'string' ? msg : JSON.stringify(msg));
    } else if (err && err.code === 'ECONNREFUSED') {
      setError('Unable to connect to the backend. Is the server running on port 5000?');
    } else {
      setError(fallback || 'An unexpected error occurred.');
    }
  };

  const handleSingleValidate = useCallback(async (e) => {
    e.preventDefault();
    if (!singleEmail.trim()) return;
    setLoading(true);
    setError(null);
    setSingleResult(null);
    setCopied(null);

    try {
      const res = await axios.post(`${API_BASE_URL}/validate-single`, {
        email: singleEmail,
      });
      setSingleResult(res.data);
    } catch (err) {
      setErrorWithDetail(
        err,
        'Failed to validate email. Ensure the backend server is running.'
      );
    } finally {
      setLoading(false);
    }
  }, [singleEmail]);

  const handleBulkValidate = useCallback(async (e) => {
    e.preventDefault();
    if (bulkEmails.length === 0) {
      setError('Please enter at least one email address.');
      return;
    }
    if (overLimit) {
      setError(
        `Too many addresses (${bulkEmails.length}). Maximum is ${MAX_BULK} per request.`
      );
      return;
    }

    setLoading(true);
    setError(null);
    setBulkResults(null);
    setCopied(null);

    try {
      const res = await axios.post(`${API_BASE_URL}/validate-bulk`, {
        emails: bulkEmails,
      });
      setBulkResults(res.data);
    } catch (err) {
      setErrorWithDetail(
        err,
        'Failed to process bulk validation. Check server connection.'
      );
    } finally {
      setLoading(false);
    }
  }, [bulkEmails, overLimit]);

  const exportCSV = useCallback(() => {
    if (!bulkResults || !bulkResults.results) return;
    const headers = ['email', 'status', 'reason', 'mailboxVerified'];
    const rows = bulkResults.results.map((r) => [
      sanitizeCell(r.email),
      sanitizeCell(r.status),
      sanitizeCell(r.reason),
      r.mailboxVerified,
    ]);
    const csv = unparse({ fields: headers, data: rows });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute(
      'download',
      `email_validation_results_${Date.now()}.csv`
    );
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [bulkResults]);

  const copyValidDomainEmails = useCallback(() => {
    if (!bulkResults || !bulkResults.results) return;
    const emails = bulkResults.results
      .filter((r) => isAcceptsMail(r.status))
      .map((r) => r.email);
    if (emails.length === 0) return;
    navigator.clipboard.writeText(emails.join('\n')).then(() => {
      setCopied(Date.now());
      setTimeout(() => setCopied(null), 2000);
    });
  }, [bulkResults]);

  // Build filtered + searchable result list.
  const allResults = bulkResults ? bulkResults.results : [];
  const filteredResults = allResults.filter((r) => {
    const matchFilter =
      filterTab === 'all' ||
      (filterTab === 'accepts' && isAcceptsMail(r.status)) ||
      (filterTab === 'invalid' && isInvalid(r.status)) ||
      (filterTab === 'disposable' && isDisposable(r.status)) ||
      (filterTab === 'unverified' && isUnverified(r.status));
    const q = searchQuery.toLowerCase();
    const matchSearch =
      !q ||
      r.email.toLowerCase().includes(q) ||
      r.status.toLowerCase().includes(q) ||
      r.reason.toLowerCase().includes(q);
    return matchFilter && matchSearch;
  });

  const summary = bulkResults ? bulkResults.summary : null;
  const acceptsCount = summary?.byStatus?.domain_accepts_mail ?? 0;

  return (
    <div className="container" role="main">
      <header className="header">
        <h1>🔍 Email Validator</h1>
        <p>
          Verify syntax, disposable domains and domain mail routing. We cannot
          confirm that an individual mailbox exists.
        </p>
      </header>

      {/* Info note (Task 3) — visible on every view */}
      <div className="info-note" role="note">
        <strong>How this works:</strong> We check email syntax, flag disposable
        / temporary providers, and look up the domain&rsquo;s mail (MX) records.
        MX records only prove a domain accepts mail &mdash; they do not verify a
        specific mailbox, so no result is ever reported as a confirmed mailbox.
      </div>

      <div className="tabs">
        <button
          className={`tab-btn ${activeTab === 'single' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('single');
            setError(null);
          }}
        >
          Single Check
        </button>
        <button
          className={`tab-btn ${activeTab === 'bulk' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('bulk');
            setError(null);
          }}
        >
          Bulk Check
        </button>
      </div>

      {/* Error banner (task 6) */}
      {error && (
        <div className="alert error" role="alert" aria-live="polite">
          {error}
          <button
            type="button"
            className="alert-dismiss"
            onClick={clearError}
            aria-label="Dismiss error"
          >
            &times;
          </button>
        </div>
      )}

      {/* Copy result toast (task 6) */}
      {copied && (
        <div className="alert success" role="status" aria-live="polite">
          Copied {acceptsCount} valid-domain email{acceptsCount === 1 ? '' : 's'}
          to clipboard.
        </div>
      )}

      {activeTab === 'single' ? (
        <div className="card">
          <form onSubmit={handleSingleValidate} noValidate>
            <div className="form-group">
              <label htmlFor="single-email">Enter Email Address</label>
              <input
                id="single-email"
                type="email"
                aria-describedby="single-email-hint"
                placeholder="name@company.com"
                value={singleEmail}
                onChange={(e) => setSingleEmail(e.target.value)}
                required
                disabled={loading}
              />
              <span id="single-email-hint" className="hint">
                Example: alex@google.com
              </span>
            </div>
            <button
              type="submit"
              className="btn-primary"
              disabled={loading}
              aria-busy={loading}
            >
              {loading ? 'Validating...' : 'Verify Email'}
            </button>
          </form>

          {singleResult && (
            <div className="result-box">
              <h3>Results for <span>{singleResult.email}</span></h3>
              <div
                className={`status-badge ${statusVariant(singleResult.status)}`}
                role="status"
                aria-label={`Status: ${statusLabel(singleResult.status)}`}
              >
                {statusLabel(singleResult.status)}
                <span className="tooltip">{STATUS_CONFIG[singleResult.status]?.tooltip || ''}</span>
              </div>
              <ul className="details-list">
                <li>
                  <strong>Syntax Check:</strong>{' '}
                  {singleResult.checks.syntax ? '✅ Pass' : '❌ Fail'}
                </li>
                <li>
                  <strong>Disposable Provider:</strong>{' '}
                  {singleResult.checks.disposable ? '⚠️ Yes (Temporary)' : '✅ No'}
                </li>
                <li>
                  <strong>MX Mail Records:</strong>{' '}
                  {singleResult.checks.mx === true
                    ? '✅ Found'
                    : singleResult.checks.mx === false
                    ? '❌ None'
                    : '⚠️ Could not check'}
                </li>
                <li>
                  <strong>Mailbox Verified:</strong>{' '}
                  <span style={{ color: '#b91c1c', fontWeight: 600 }}>
                    No — not verifiable from MX records
                  </span>
                </li>
                <li><strong>Details:</strong> {singleResult.reason}</li>
              </ul>
            </div>
          )}
        </div>
      ) : (
        <div className="card">
          <form onSubmit={handleBulkValidate} noValidate>
            <div className="form-group">
              <label htmlFor="bulk-input">Paste Email List</label>
              <textarea
                id="bulk-input"
                rows="8"
                aria-describedby="bulk-input-hint bulk-counter"
                placeholder="alex@google.com\ntest@10minutemail.com\nuser@nonexistentdomain123.com"
                value={bulkInput}
                onChange={(e) => setBulkInput(e.target.value)}
                disabled={loading}
              />
              <div className="input-hint-row">
                <span id="bulk-input-hint" className="hint">
                  Separate addresses by newline, comma, or semicolon.
                </span>
                <span id="bulk-counter" className={`counter ${overLimit ? 'over' : ''}`}>
                  {bulkEmails.length} / {MAX_BULK} emails
                </span>
              </div>
            </div>
            <button
              type="submit"
              className="btn-primary"
              disabled={loading || overLimit || bulkEmails.length === 0}
              aria-busy={loading}
            >
              {loading ? 'Validating Batch...' : 'Verify All Emails'}
            </button>
          </form>

          {bulkResults && (
            <div className="bulk-results-section">
              <div className="metrics-row">
                <div className="metric-card">
                  <h4>Submitted</h4>
                  <p>{summary?.submitted ?? 0}</p>
                </div>
                <div className="metric-card">
                  <h4>Processed</h4>
                  <p>{summary?.processed ?? 0}</p>
                </div>
                <div className="metric-card">
                  <h4>Duplicates Removed</h4>
                  <p>{summary?.duplicatesRemoved ?? 0}</p>
                </div>
                <div className="metric-card accepts">
                  <h4>Accepts Mail</h4>
                  <p>{acceptsCount}</p>
                </div>
                <div className="metric-card disposable">
                  <h4>Disposable</h4>
                  <p>{summary?.byStatus?.disposable ?? 0}</p>
                </div>
                <div className="metric-card dns">
                  <h4>Unverified (DNS)</h4>
                  <p>{summary?.byStatus?.dns_error ?? 0}</p>
                </div>
                <div className="metric-card invalid">
                  <h4>Invalid</h4>
                  <p>{[
                    'invalid_syntax',
                    'domain_not_found',
                    'no_mx_records',
                  ]
                    .map((k) => summary?.byStatus?.[k] ?? 0)
                    .reduce((a, b) => a + b, 0)}</p>
                </div>
              </div>

              <div className="table-header-row">
                <div>
                  <h3>Verification Details</h3>
                  <p className="hint">
                    {filteredResults.length} of {allResults.length} results shown
                  </p>
                </div>
                <div className="actions">
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={exportCSV}
                    disabled={!bulkResults.results?.length || loading}
                    aria-label="Export results to CSV"
                  >
                    📥 Export CSV
                  </button>
                  {acceptsCount > 0 && (
                    <button
                      type="button"
                      className="btn-secondary btn-copy"
                      onClick={copyValidDomainEmails}
                      disabled={loading || copied}
                      aria-label="Copy addresses whose domain accepts mail"
                    >
                      {copied ? '✅ Copied!' : '📋 Copy Accepts-Mail Emails'}
                    </button>
                  )}
                </div>
              </div>

              {/* Filter tabs (task 7) */}
              <div className="filter-tabs" role="tablist" aria-label="Filter results">
                {[
                  { id: 'all', label: 'All' },
                  { id: 'accepts', label: 'Accepts Mail' },
                  { id: 'invalid', label: 'Invalid' },
                  { id: 'disposable', label: 'Disposable' },
                  { id: 'unverified', label: 'Unverified (DNS)' },
                ].map((item) => (
                  <button
                    key={item.id}
                    role="tab"
                    aria-selected={filterTab === item.id}
                    className={`filter-btn ${filterTab === item.id ? 'active' : ''}`}
                    onClick={() => setFilterTab(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              <div className="form-group search-group" style={{ marginBottom: 12 }}>
                <label htmlFor="result-search" className="visually-hidden">
                  Search results
                </label>
                <input
                  id="result-search"
                  type="search"
                  placeholder="Search email, status or reason…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  aria-label="Search results"
                />
              </div>

              <div className="table-container">
                {filteredResults.length === 0 && (
                  <div className="empty-state">
                    <p>No results match the current filter and search.</p>
                  </div>
                )}
                <table aria-label="Validation results">
                  <thead>
                    <tr>
                      <th scope="col">Email</th>
                      <th scope="col">Status</th>
                      <th scope="col">Syntax</th>
                      <th scope="col">Disposable</th>
                      <th scope="col">MX Records</th>
                      <th scope="col">Mailbox Verified</th>
                      <th scope="col">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredResults.map((res, idx) => (
                      <tr key={idx}>
                        <td>{res.email}</td>
                        <td>
                          <span
                            className={`badge ${statusVariant(res.status)}`}
                            aria-label={statusLabel(res.status)}
                          >
                            {statusLabel(res.status)}
                          </span>
                        </td>
                        <td>{res.checks.syntax ? 'Pass' : 'Fail'}</td>
                        <td>{res.checks.disposable ? 'Yes' : 'No'}</td>
                        <td>
                          {res.checks.mx === true
                            ? 'Found'
                            : res.checks.mx === false
                            ? 'None'
                            : 'Could not check'}
                        </td>
                        <td>
                          <span style={{ color: '#b91c1c', fontWeight: 600 }}>
                            No
                          </span>
                        </td>
                        <td className="reason-cell">{res.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default App;
