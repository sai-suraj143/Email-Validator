# Email Validator

A full-stack email validation application (Node.js/Express + React) designed to perform
bulk email validation (syntax, disposable domain detection, and DNS/MX record verification)
for lead lists and cold outreach campaigns.

**Important:** MX records only prove that a domain accepts mail — they do not verify that a
specific mailbox exists. This API never reports a mailbox as confirmed "Valid". The strongest
honest claim is `domain_accepts_mail` with `mailboxVerified: false`.

## Features
- **Single Email Check:** Instant validation for one email address.
- **Bulk Email Check:** Validates lists of up to 100 emails at once with bounded concurrency
  and per-request/cross-request domain caching.
- **Evidence-based statuses:** `invalid_syntax`, `disposable`, `no_mx_records`,
  `domain_not_found`, `dns_error`, `domain_accepts_mail`.
- **Syntax validation** via the well-maintained `validator` library (max 254 chars total,
  64 for the local part).
- **CSV export** with safe escaping and formula-injection neutralization.
- **Modern UI:** Clean, responsive dashboard built with React.
- **Production-ready:** structured logging, rate limiting, CORS allowlist, optional API key,
  graceful shutdown, Docker support.
- **Quality gates:** Jest + Supertest backend tests, React Testing Library frontend tests,
  GitHub Actions CI, and honest documentation.

## Status Meanings

| Status | Meaning | Mailbox Verified? |
|---|---|---|
| `invalid_syntax` | Email fails syntax or length checks | No |
| `disposable` | Domain is a known disposable/temporary provider | No |
| `no_mx_records` | Domain exists (has A/AAAA records) but no MX records | No |
| `domain_not_found` | Domain does not exist (NXDOMAIN) | No |
| `dns_error` | DNS lookup timed out or temporarily failed — not treated as invalid | No |
| `domain_accepts_mail` | Domain has MX records; accepts mail but mailbox not verified | No |

No status ever confirms that an individual mailbox exists.

## Limitations

- **MX records do not prove a mailbox exists.** The API checks whether a domain accepts mail
  (via MX records), but it cannot verify that a specific mailbox (the part before `@`) is
  deliverable. SMTP-level verification (RCPT TO) is intentionally not performed because it
  is unreliable, often blocked by providers, and can be considered abusive.
- `dns_error` means the DNS lookup could not complete in time — it is **not** treated as
  evidence that the domain is invalid. Retry later.
- Disposable domain detection is based on a maintained list of known providers; new or
  obscure disposable domains may not be caught.

## API Reference

### Base URL
`http://localhost:5000/api` (configurable via `REACT_APP_API_URL` on the frontend).

### POST `/api/validate-single`
Validate a single email address.

**Request:**
```json
{ "email": "fakeuser123@gmail.com" }
```

**Response (200):**
```json
{
  "email": "fakeuser123@gmail.com",
  "status": "domain_accepts_mail",
  "reason": "Domain has MX records; accepts mail but mailbox not verified",
  "checks": { "syntax": true, "disposable": false, "mx": true },
  "mailboxVerified": false
}
```

**Response (400):**
```json
{ "error": { "code": 400, "message": "Email address is required and must be a string." } }
```

### POST `/api/validate-bulk`
Validate a list of email addresses (maximum 100 per request).

**Request:**
```json
{ "emails": ["user@gmail.com", "test@mailinator.com", "bad@@email"] }
```

**Response (200):**
```json
{
  "summary": {
    "submitted": 3,
    "unique": 3,
    "processed": 3,
    "duplicatesRemoved": 0,
    "total": 3,
    "byStatus": {
      "domain_accepts_mail": 1,
      "disposable": 1,
      "invalid_syntax": 1
    }
  },
  "results": [ ... ]
}
```

**Response (400 — too many):**
```json
{ "error": { "code": 400, "message": "\"emails\" exceeds the maximum of 100 addresses per request (submitted 101)." } }
```

### GET `/api/health`
Health check.

**Response (200):**
```json
{ "status": "ok", "uptime": 123.45 }
```

## Project Structure
```
mern-email-validator/
├── backend/
│   ├── .env.example
│   ├── Dockerfile
│   ├── package.json
│   ├── package-lock.json
│   ├── server.js
│   ├── cache/
│   │   └── domainCache.js
│   ├── data/
│   │   └── disposableDomains.js
│   └── validators/
│       └── emailValidator.js
├── frontend/
│   ├── .env.example
│   ├── package.json
│   ├── package-lock.json
│   ├── public/
│   │   └── index.html
│   └── src/
│       ├── App.css
│       ├── App.jsx
│       └── index.js
├── .github/
│   └── workflows/
│       └── ci.yml
├── docker-compose.yml
├── package.json
└── README.md
```

## Getting Started & Local Setup

### Step 1: Extract the Zip File
Unzip into your workspace.

### Step 2: Configure the Backend
```bash
cd backend
cp .env.example .env
# Edit .env as needed (CORS_ORIGINS, API_KEY, etc.)
npm install
```

### Step 3: Start the Backend
```bash
# Production
npm start        # node server.js

# Development (auto-reload)
npm run dev      # nodemon server.js
```
The server runs on `http://localhost:5000` (or `PORT` from `.env`).

### Step 4: Start the Frontend
Open a new terminal window/tab:
```bash
cd frontend
cp .env.example .env   # optional; defaults to http://localhost:5000/api
npm install
npm start              # React app on http://localhost:3000
```

### Step 5: Open in Browser
Navigate to `http://localhost:3000`.

## Running Tests

### Backend
```bash
cd backend
npm test
```

### Frontend
```bash
cd frontend
npm test
```

### From the repository root
```bash
npm test
```

## Deployment

### Backend (Docker)
```bash
cd backend
docker build -t email-validator-backend .
docker run -p 5000:5000 --env-file .env email-validator-backend
```

### Frontend (production build)
```bash
cd frontend
npm install
npm run build        # produces static files in build/
```
Serve the `build/` folder with any static file server (nginx, serve, etc.):
```bash
npx serve -s build
```

### All-in-one (docker-compose)
```bash
docker-compose up --build
```
This builds and runs both backend (port 5000) and frontend (port 3000).
Set `CORS_ORIGINS` in `backend/.env` to your frontend origin.

## Available Scripts (backend)
- `npm start` — production server (`node server.js`)
- `npm run dev` — development with auto-reload (`nodemon server.js`)
- `npm test` — run Jest + Supertest test suite

## Available Scripts (frontend)
- `npm start` — development server (`react-scripts start`)
- `npm run build` — production build (`react-scripts build`)
- `npm test` — run React Testing Library test suite

## Available Scripts (root)
- `npm run install:all` — install dependencies for all packages
- `npm run dev` — run backend and frontend concurrently in development
- `npm test` — run all tests
- `npm run build` — build the frontend for production

## Environment Variables (backend)
| Variable | Description | Default |
|---|---|---|
| PORT | Server port | 5000 |
| LOG_LEVEL | pino log level | info |
| CORS_ORIGINS | Comma-separated allowed origins | (allow all) |
| MAX_BULK | Max emails per bulk request | 100 |
| CONCURRENCY | Bulk validation concurrency | 10 |
| DNS_TIMEOUT_MS | DNS lookup timeout | 5000 |
| CACHE_TTL_MS | Domain cache TTL (ms) | 300000 |
| RATE_LIMIT_WINDOW_MS | Rate limit window (ms) | 900000 |
| RATE_LIMIT_MAX | Max requests per window | 100 |
| API_KEY | Optional API key (`x-api-key` header) | (none) |
