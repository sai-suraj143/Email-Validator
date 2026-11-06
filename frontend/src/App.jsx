import React, { useState } from 'react';
import axios from 'axios';
import './App.css';

const API_BASE_URL = 'http://localhost:5000/api';

function App() {
  const [activeTab, setActiveTab] = useState('single');
  const [singleEmail, setSingleEmail] = useState('');
  const [bulkInput, setBulkInput] = useState('');
  const [singleResult, setSingleResult] = useState(null);
  const [bulkResults, setBulkResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSingleValidate = async (e) => {
    e.preventDefault();
    if (!singleEmail.trim()) return;
    setLoading(true);
    setError('');
    setSingleResult(null);

    try {
      const res = await axios.post(`${API_BASE_URL}/validate-single`, { email: singleEmail });
      setSingleResult(res.data);
    } catch (err) {
      setError('Failed to validate email. Ensure backend server is running on port 5000.');
    } finally {
      setLoading(false);
    }
  };

  const handleBulkValidate = async (e) => {
    e.preventDefault();
    const emailsList = bulkInput
      .split(/\n|,/)
      .map(e => e.trim())
      .filter(e => e.length > 0);

    if (emailsList.length === 0) {
      setError('Please enter at least one email address.');
      return;
    }

    setLoading(true);
    setError('');
    setBulkResults(null);

    try {
      const res = await axios.post(`${API_BASE_URL}/validate-bulk`, { emails: emailsList });
      setBulkResults(res.data);
    } catch (err) {
      setError('Failed to process bulk validation. Check server connection.');
    } finally {
      setLoading(false);
    }
  };

  const exportCSV = () => {
    if (!bulkResults || !bulkResults.results) return;
    const headers = ['Email', 'Status', 'Valid Syntax', 'Disposable', 'MX Records', 'Reason'];
    const rows = bulkResults.results.map(r => [
      `"${r.email}"`,
      `"${r.status}"`,
      r.checks?.syntax ? 'Yes' : 'No',
      r.checks?.disposable ? 'Yes' : 'No',
      r.checks?.mx ? 'Yes' : 'No',
      `"${r.reason}"`
    ]);

    const csvContent = "data:text/csv;charset=utf-8," + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `email_validation_results_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="container">
      <header className="header">
        <h1>🔍 Bulk Email Validator</h1>
        <p>Verify lead lists, eliminate hard bounces, and protect your domain reputation—100% free.</p>
      </header>

      <div className="tabs">
        <button 
          className={`tab-btn ${activeTab === 'single' ? 'active' : ''}`}
          onClick={() => { setActiveTab('single'); setError(''); }}
        >
          Single Check
        </button>
        <button 
          className={`tab-btn ${activeTab === 'bulk' ? 'active' : ''}`}
          onClick={() => { setActiveTab('bulk'); setError(''); }}
        >
          Bulk Check
        </button>
      </div>

      {error && <div className="alert error">{error}</div>}

      {activeTab === 'single' ? (
        <div className="card">
          <form onSubmit={handleSingleValidate}>
            <div className="form-group">
              <label>Enter Email Address</label>
              <input 
                type="email" 
                placeholder="name@company.com" 
                value={singleEmail} 
                onChange={(e) => setSingleEmail(e.target.value)}
                required 
              />
            </div>
            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? 'Validating...' : 'Verify Email'}
            </button>
          </form>

          {singleResult && (
            <div className="result-box">
              <h3>Results for <span>{singleResult.email}</span></h3>
              <div className={`status-badge ${singleResult.status.toLowerCase()}`}>
                Status: {singleResult.status}
              </div>
              <ul className="details-list">
                <li><strong>Syntax Check:</strong> {singleResult.checks.syntax ? '✅ Valid' : '❌ Invalid'}</li>
                <li><strong>Disposable Provider:</strong> {singleResult.checks.disposable ? '❌ Yes (Temporary)' : '✅ No'}</li>
                <li><strong>MX Mail Records:</strong> {singleResult.checks.mx ? '✅ Active Server' : '❌ No MX Records'}</li>
                <li><strong>Details:</strong> {singleResult.reason}</li>
              </ul>
            </div>
          )}
        </div>
      ) : (
        <div className="card">
          <form onSubmit={handleBulkValidate}>
            <div className="form-group">
              <label>Paste Email List (One per line or comma-separated)</label>
              <textarea 
                rows="8" 
                placeholder={"alex@google.com\ntest@10minutemail.com\nuser@nonexistentdomain123.com"} 
                value={bulkInput} 
                onChange={(e) => setBulkInput(e.target.value)}
              />
            </div>
            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? 'Validating Batch...' : 'Verify All Emails'}
            </button>
          </form>

          {bulkResults && (
            <div className="bulk-results-section">
              <div className="metrics-row">
                <div className="metric-card">
                  <h4>Total Verified</h4>
                  <p>{bulkResults.summary?.processed ?? 0}</p>
                </div>
                <div className="metric-card valid">
                  <h4>Valid Leads</h4>
                  <p>{(bulkResults.summary?.byStatus?.domain_accepts_mail ?? 0)}</p>
                </div>
                <div className="metric-card invalid">
                  <h4>Invalid/Risky</h4>
                  <p>{(
                    (bulkResults.summary?.byStatus?.invalid_syntax ?? 0) +
                    (bulkResults.summary?.byStatus?.domain_not_found ?? 0) +
                    (bulkResults.summary?.byStatus?.dns_error ?? 0)
                  )}</p>
                </div>
                <div className="metric-card disposable">
                  <h4>Disposable</h4>
                  <p>{bulkResults.summary?.byStatus?.disposable ?? 0}</p>
                </div>
              </div>

              <div className="table-header-row">
                <h3>Verification Details</h3>
                <button className="btn-secondary" onClick={exportCSV}>📥 Export CSV</button>
              </div>

              <div className="table-container">
                <table>
                  <thead>
                    <tr>
                      <th>Email</th>
                      <th>Status</th>
                      <th>Syntax</th>
                      <th>Disposable</th>
                      <th>MX Records</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bulkResults.results.map((res, idx) => (
                      <tr key={idx}>
                        <td>{res.email}</td>
                        <td>
                          <span className={`badge ${res.status.toLowerCase()}`}>
                            {res.status}
                          </span>
                        </td>
                        <td>{res.checks?.syntax ? 'Pass' : 'Fail'}</td>
                        <td>{res.checks?.disposable ? 'Yes' : 'No'}</td>
                        <td>{res.checks?.mx ? 'Found' : 'Missing'}</td>
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
