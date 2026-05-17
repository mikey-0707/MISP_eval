# Presentation Evaluation Service

This is a small local Node.js service for weekly presentation evaluations.

## Run Locally

```powershell
npm start
```

Student page:

```text
http://localhost:3000/
```

Admin URL is printed at startup and stored through `data/admin-key.txt`.

## Workflow

1. Open the admin URL.
2. Press `Start` for the group currently presenting.
3. Read the generated six-digit code aloud.
4. Students enter their student ID and name, enter the code, and choose a 1-5 rating for:

```text
I am willing to purchase this product.
```

Only the first response from the same student ID is recorded for each presentation. The submitter's IP hash is still recorded for audit purposes.

Use `Reset Votes` in the admin table to clear recorded votes for a single presentation while keeping the presentation session controls available.
Use each row's `Excel` link to download the full response data for that presentation session.

## Scheduled Operation

Register Windows Scheduled Tasks for the presentation dates:

```powershell
.\scripts\register-scheduled-tasks.ps1 -Port 3000
```

The registered dates are:

- 2026-05-18, 11:50-13:30
- 2026-06-01, 11:50-13:30
- 2026-06-08, 11:50-13:30
- 2026-06-15, 11:50-13:30

Week 12, 2026-05-25, is skipped because it is listed as a substitute public holiday.

## Email Setup

`scripts/start-service.ps1` sends the admin URL to `myounggulee@konkuk.ac.kr` when SMTP environment variables are configured:

```powershell
$env:SMTP_HOST = "smtp.example.com"
$env:SMTP_PORT = "587"
$env:SMTP_USER = "sender@example.com"
$env:SMTP_PASS = "app-password"
$env:SMTP_FROM = "sender@example.com"
$env:SMTP_SSL = "true"
```

If SMTP is not configured, the admin URL is written to `logs/admin-url-email.txt`.

For a public classroom URL, set `PUBLIC_BASE_URL` or pass `-PublicBaseUrl` when registering tasks.

## Web Deployment

Use a host that supports a long-running Node server and persistent storage, such as Render, Railway, Fly.io, or a VPS.

Render deployment files are included:

- `render.yaml`
- `Dockerfile`

Required production environment values:

```text
PUBLIC_BASE_URL=https://your-service-url.example.com
APP_DATA_DIR=/var/data
```

Recommended environment values:

```text
ADMIN_KEY=<long-random-admin-secret>
SMTP_HOST=<smtp-host>
SMTP_PORT=587
SMTP_USER=<smtp-username>
SMTP_PASS=<smtp-password>
SMTP_FROM=<sender-email>
SMTP_SSL=true
```

The app exposes a health endpoint at `/api/health`.
