const express = require('express');
const cors = require('cors');

const { validateEmail } = require('./validators/emailValidator');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Single Email API Endpoint
app.post('/api/validate-single', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email address is required' });
    }
    const validationResult = await validateEmail(email);
    res.json(validationResult);
  } catch (error) {
    res.status(500).json({ error: 'Server error during validation' });
  }
});

// Bulk Email API Endpoint (Concurrent async validation)
app.post('/api/validate-bulk', async (req, res) => {
  try {
    const { emails } = req.body;
    if (!Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ error: 'Array of email addresses is required' });
    }

    // Limit batch size per request for performance
    const batch = emails.slice(0, 100);
    const results = await Promise.all(batch.map((email) => validateEmail(email)));

    const summary = {
      total: results.length,
      valid: results.filter((r) => r.status === 'domain_accepts_mail').length,
      invalid: results.filter(
        (r) =>
          r.status === 'invalid_syntax' ||
          r.status === 'domain_not_found' ||
          r.status === 'dns_error'
      ).length,
      disposable: results.filter((r) => r.status === 'disposable').length,
      noMx: results.filter((r) => r.status === 'no_mx_records').length,
    };

    res.json({ summary, results });
  } catch (error) {
    res.status(500).json({ error: 'Server error during bulk validation' });
  }
});

app.listen(PORT, () => {
  console.log(`Email Validator Server running on http://localhost:${PORT}`);
});
