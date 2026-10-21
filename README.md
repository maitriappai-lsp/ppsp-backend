# Maitri LSP -- Backend

Node.js/Express + PostgreSQL API for the Maitri LSP app (Section 6 of the
spec). This replaces the AsyncStorage mock in `maitri-lsp-app/src/data/store.js`.

## What it does

- Serves the entire app's data (`GET /api/db`) in the exact shape the client
  already expects (`{ resources, beneficiaries, categories, geo, schedule,
  psr, uploads, content, overrides, systemParameters }`), so the client
  swap is just "fetch instead of AsyncStorage."
- Generic CRUD for every master/transaction table (`POST/PATCH/DELETE
  /api/:table/:id`) -- the client still generates its own record ids
  (`nextId()`), the server just persists them.
- Real auth: phone + password login, bcrypt-hashed passwords, a JWT bearer
  token the client attaches to every request. (The mock had no real
  security -- passwords sat in plaintext in an in-memory array.)
- Attendance override audit log with a **server-assigned** id and
  timestamp (an audit log can't trust the client's clock).
- File storage for uploads/content (`POST /api/files`, multipart) --
  replaces the "metadata only, no S3 yet" stub. Uses Cloudflare R2
  (persistent, survives restarts/redeploys) when configured, or local disk
  otherwise -- see "Persistent file uploads" below.

## Not yet done (next steps)

- Server-side Excel import parsing (`exceljs`) for the Admin "Import from
  Excel" stubs -- endpoint would be `POST /api/:table/import` accepting a
  spreadsheet and upserting by code.
- Real Excel export for the two dashboards.
- On-device face embedding/match is a client-side concern (the backend just
  stores `facialDataCaptured` and the override log if a facilitator's face
  check is bypassed).
- Role-based authorization is minimal right now (a valid token is required,
  but any authenticated user can hit any endpoint). Add a
  `requireRole('Admin')` middleware for the Admin-only Masters/Schedule/
  Override endpoints before this goes anywhere near production data.
- Rate limiting / login throttling on `/api/auth/login`.

## Setup

You'll need Node.js 18+ and either Docker or a local PostgreSQL install.

```bash
cd backend
npm install
cp .env.example .env          # edit if your Postgres isn't on localhost:5432

# Start Postgres (skip if you already have one running)
docker compose up -d

npm run migrate               # creates tables
npm run seed                  # loads the same demo data as mockData.js
npm start                     # http://localhost:4000
```

Check it's alive: `curl http://localhost:4000/health` -> `{"ok":true}`

## Demo logins (unchanged from the mock)

| Phone | Password | Role |
|---|---|---|
| 9840012345 | changeme123 | Facilitator (Divya Shankar) |
| 9840023456 | changeme123 | Facilitator, forces password change (Karthik Raman) |
| 9840034567 | changeme123 | Programme Admin (Priya Menon) |

## Pointing the app at this backend

In `maitri-lsp-app/src/config.js`, set `API_BASE_URL` to wherever this
server is reachable from your phone/emulator:

- Android emulator: `http://10.0.2.2:4000`
- iOS simulator: `http://localhost:4000`
- Physical phone via Expo Go: `http://<your-computer's-LAN-IP>:4000`
  (phone and computer must be on the same Wi-Fi)

## API summary

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/login` | `{ phone, password }` -> `{ ok, user, token }` |
| POST | `/api/auth/change-password` | `{ resourceId, newPassword }` |
| GET | `/api/db` | Everything, in one call. Requires `Authorization: Bearer <token>` |
| POST | `/api/:table` | `:table` is one of resources/beneficiaries/categories/geo/schedule/psr/uploads/content |
| PATCH | `/api/:table/:id` | Partial update |
| DELETE | `/api/:table/:id` | |
| POST | `/api/overrides` | `{ resourceId, bypassGeofence, bypassFace, reason, loggedBy }` -- id + timestamp are server-assigned |
| POST | `/api/files` | multipart, field `file` -> `{ fileName, storagePath, url }` |

All `/api/*` routes except `/api/auth/*` require the bearer token from login.

## Persistent file uploads (Cloudflare R2)

By default, uploaded photos/PDFs go to local disk (`backend/uploads/`) --
fine for local testing, but lost on every restart/redeploy on a host like
Render. For uploads that actually persist (months, not until-the-next-
restart), set up Cloudflare R2 -- free for 10GB storage, no egress fees,
nothing deleted for inactivity:

1. Create a free account at [cloudflare.com](https://cloudflare.com), then
   go to **R2 Object Storage** in the dashboard and create a bucket (any
   name, e.g. `maitri-lsp-uploads`).
2. In the bucket's **Settings**, enable **Public Development URL** -- this
   gives you a base URL like `https://pub-xxxx.r2.dev`. Copy it.
3. Back in the R2 dashboard, go to **Manage API Tokens** and create a token
   with **Object Read & Write** permission, scoped to this bucket. It'll
   show an Access Key ID and Secret Access Key -- copy both (the secret is
   only shown once).
4. Find your **Account ID** (shown on the main Cloudflare dashboard page,
   or in R2's own overview page).
5. Set these five environment variables (in `.env` locally, or in Render's
   Environment settings for a deployed backend):
   ```
   R2_ACCOUNT_ID=<your account id>
   R2_ACCESS_KEY_ID=<from step 3>
   R2_SECRET_ACCESS_KEY=<from step 3>
   R2_BUCKET_NAME=maitri-lsp-uploads
   R2_PUBLIC_URL_BASE=https://pub-xxxx.r2.dev
   ```
6. Restart the backend. Its startup log will print either "File storage:
   Cloudflare R2 (persistent)" or "File storage: local disk" -- confirming
   which mode is active.

Leaving all five blank keeps local-disk behavior, so this is entirely
optional for local-only testing.

## Deploying for remote testing (Neon + Render)

For testing with someone outside your local network, `localhost`/LAN
addresses won't reach them. This pairs a permanent free Postgres host with a
permanent free backend host (Render's own free *Postgres* expires after 30
days and gets deleted -- Neon's free Postgres doesn't expire):

1. Create a free database at [neon.tech](https://neon.tech) and copy its
   connection string (looks like
   `postgres://user:pass@ep-xxx.neon.tech/dbname?sslmode=require`).
2. Push this `backend/` folder to a GitHub repo.
3. On [render.com](https://render.com), create a **Web Service** from that
   repo. Root directory: `backend`. Build command: `npm install`. Start
   command: `npm start`.
4. Add environment variables on Render: `DATABASE_URL` (from step 1),
   `DB_SSL=true`, `JWT_SECRET` (any long random string).
5. Once live, run the migration and seed **from your own machine**, with
   `.env`'s `DATABASE_URL` and `DB_SSL=true` temporarily pointed at the Neon
   string from step 1: `npm run migrate` then `npm run seed`. This reaches
   Neon directly over the internet -- no need for Render shell access.
6. Set `API_BASE_URL` in `maitri-lsp-app/src/config.js` to Render's URL
   (`https://<your-service>.onrender.com`) -- this now works for anyone,
   anywhere, not just your LAN.

Known limitation: Render's free web services don't have persistent disk, so
without R2 configured (see "Persistent file uploads" above), anything saved
via `POST /api/files` (photo/PDF uploads) would be lost on the service's
next restart or redeploy. Set the five `R2_*` environment variables on
Render too and this is resolved -- uploads then persist in R2 regardless of
what happens to the web service itself.

## Note on this build

This backend was written and reviewed for correctness but **not run or
tested end-to-end** in the environment that generated it (no outbound
network access there to install npm packages or spin up Postgres). Run
`npm install` and walk through the setup steps above before relying on it --
if anything doesn't line up with your local Postgres version or Node
version, the error messages should point at it quickly given how small each
route file is.
