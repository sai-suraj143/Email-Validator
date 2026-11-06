# MERN Stack Email Validator

An open-source, full-stack MERN (Node.js/Express + React) application designed to perform bulk email validation (Syntax, Disposable Domain Detection, and DNS/MX Record Verification) for cold outreach campaigns.

## Features
- **Single Email Check:** Instant validation for one email address.
- **Bulk Email Check:** Concurrently verifies lists of 10 to 100 emails at once using asynchronous `Promise.all()`.
- **3-Tier Verification:**
  - Regular Expression Syntax Check.
  - Disposable Domain Detection (filters temporary mailboxes).
  - Native DNS MX Record Lookup (`dns.resolveMx`).
- **CSV Export:** Download validated email list with color-coded status badges and failure reasons.
- **Modern UI:** Clean dashboard built with React and custom responsive CSS.

---

## Project Structure
```
mern-email-validator/
├── backend/
│   ├── package.json
│   └── server.js
└── frontend/
    ├── package.json
    ├── public/
    │   └── index.html
    └── src/
        ├── App.css
        ├── App.jsx
        └── index.js
```

---

## Getting Started & Local Setup

### Step 1: Extract the Zip File
Unzip `mern-email-validator.zip` into your workspace.

### Step 2: Start the Backend Server
```bash
cd backend
npm install
npm run dev  # Starts server on http://localhost:5000
```

### Step 3: Start the Frontend Application
Open a new terminal window/tab:
```bash
cd frontend
npm install
npm start    # Starts React app on http://localhost:3000
```

### Step 4: Open in Browser
Navigate to `http://localhost:3000` to start validating your leads!
