# Aging-Test — Firebase-Only Deployment Guide

> **Last updated**: 2026-10-03  
> **Firebase project**: `agingtest-57600`  
> **Public URL**: https://agingtest-57600.web.app

---

## Table of contents

1. [Architecture](#architecture)
2. [Project structure](#project-structure)
3. [Prerequisites](#prerequisites)
4. [Firebase Console one-time setup](#firebase-console-one-time-setup)
5. [First-time local setup](#first-time-local-setup)
6. [Local development (emulators)](#local-development-emulators)
7. [All npm scripts](#all-npm-scripts)
8. [Deploy to production](#deploy-to-production)
9. [Data import](#data-import)
10. [Operator management](#operator-management)
11. [Testing](#testing)
12. [Production migration procedure](#production-migration-procedure)
13. [Rollback procedure](#rollback-procedure)
14. [Troubleshooting](#troubleshooting)

---

## Architecture

```
Browser (React SPA)
  │  /api/* requests (with Firebase ID token header)
  ▼
Firebase Hosting (CDN)
  │  rewrite /api/** → Cloud Function (before SPA fallback)
  ▼
Cloud Function  api  (Python 3.12, 512 MB, 120 s timeout)
  ├── Firebase Auth ID-token verification  (operator: true custom claim)
  ├── Battery OCR (RapidOCR / ONNX / OpenCV-headless)  [public — no auth]
  ├── Workflow engine (register → start-aging → H1–H4 → post-aging)
  └── Firestore Admin SDK
          │
          ▼
     Cloud Firestore
       collections/
         devices/{serial}   — device state, observations, events
         captures/{token}   — expiring single-use capture tokens
```

### What replaced what

| Before | After |
|--------|-------|
| FastAPI on Render | Firebase Cloud Function (Python 3.12) |
| Supabase Postgres | Cloud Firestore |
| Excel workbook | Firestore (Excel kept for import only) |
| `VITE_BACKEND_URL` env var | Relative `/api/` URL + Hosting rewrite |
| Supabase Auth | Firebase Authentication (Email/Password) |

---

## Project structure

```
aging-test/
  firebase.json            # Hosting + Functions + Firestore + Emulators config
  .firebaserc              # Firebase project alias (agingtest-57600)
  firestore.rules          # Security rules (blocks direct client writes)
  firestore.indexes.json   # Composite indexes for captures and devices
  package.json             # Root scripts (build / deploy / migrate)
  pytest.ini               # Backend test config
  frontend/                # React + TypeScript + Vite SPA
    src/
      firebase.ts          # Firebase client SDK init (Auth)
      AuthGate.tsx         # Login screen / sign-out affordance
      api.ts               # HTTP client — injects ID tokens
      App.tsx              # Main application
      ...
  functions/               # Python 2nd-gen Cloud Functions
    main.py                # ALL API endpoints + auth verification + OCR + workflow
    requirements.txt       # rapidocr, onnxruntime, opencv, firebase-admin
  scripts/
    backup_supabase.mjs    # Backup Supabase → JSON  (pre-migration)
    import_from_supabase.mjs  # Import JSON/CSV → Firestore  (non-destructive)
    import_from_excel.mjs     # Import Excel workbook → Firestore
    verify_migration.mjs      # Verify Firestore matches backup
    add_operator.mjs          # Grant/revoke operator:true custom claim
  tests/
    firebase/
      test_workflow.py     # Integration tests (needs emulators)
      test_ocr_emulator.py # OCR endpoint tests (needs emulators)
      test_auth.py         # Auth gate tests (needs emulators)
    fixtures/              # Sample battery photos for OCR tests
```

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | ≥ 22 | https://nodejs.org |
| Python | 3.12 | https://python.org |
| Firebase CLI | latest | `npm install -g firebase-tools` |
| Git | any | https://git-scm.com |

> **Blaze billing plan required** for Cloud Functions.  
> Console → Project Settings → Usage and billing → Modify plan → Blaze

---

## Firebase Console one-time setup

Open: https://console.firebase.google.com/project/agingtest-57600

### 1. Enable Blaze billing

> Project Settings → Usage and billing → Modify plan → **Blaze (pay-as-you-go)**

### 2. Enable Firestore

> Build → Firestore Database → Create database → **Native mode**, region `us-central1`

### 3. Enable Authentication

> Build → Authentication → Get started → Sign-in method → Enable **Email/Password**

### 4. Get web app config

> Project Settings → Your apps → Web app → Config

Copy the values into `frontend/.env` (see [First-time local setup](#first-time-local-setup)).

### 5. Create operator accounts

Create user accounts for each operator:
> Authentication → Users → Add user

Then grant the `operator: true` custom claim (required for API access):

```powershell
# Windows PowerShell
npm run operator:add -- --email operator@example.com
```

> The user must **sign out and sign back in** after the claim is added for it to take effect.

### 6. Deploy Firestore rules and indexes (first-time)

```powershell
firebase deploy --only firestore
```

---

## First-time local setup

```powershell
# 1. Install all dependencies
npm install              # root (firebase-admin, xlsx for migration scripts)
npm install --prefix frontend   # React + Firebase SDK

# 2. Login to Firebase
firebase login

# 3. Copy and fill environment variables
Copy-Item frontend\.env.example frontend\.env
notepad frontend\.env
```

Fill in `frontend/.env`:

```env
VITE_FIREBASE_API_KEY=AIza...
VITE_FIREBASE_AUTH_DOMAIN=agingtest-57600.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=agingtest-57600
VITE_FIREBASE_STORAGE_BUCKET=agingtest-57600.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=123456789
VITE_FIREBASE_APP_ID=1:123456789:web:abc123
```

---

## Local development (emulators)

### Start the Firebase emulator suite

```powershell
npm run emulate
```

This starts (all local, no cloud calls):

| Service | URL |
|---------|-----|
| Hosting | http://localhost:5000 |
| Functions | http://localhost:5001 |
| Firestore | http://localhost:8080 |
| Authentication | http://localhost:9099 |
| Emulator UI | http://localhost:4000 |

Data is persisted in `./emulator-data/` between runs.

### Start the Vite dev server (in a separate terminal)

```powershell
npm run dev
```

The Vite server starts at https://localhost:5173 (or the LAN IP if certificates are installed).  
All `/api/*` requests are proxied to the Functions emulator.

> **Camera / OCR requires HTTPS.**  Run `scripts/setup-https.ps1` first to create self-signed
> LAN certificates, then use the HTTPS LAN URL on your mobile device.

### Install Python dependencies for local OCR

```powershell
cd functions
pip install -r requirements.txt
cd ..
```

> Without this, the OCR endpoint will return `"OCR engine still initialising"` in the emulator.

---

## All npm scripts

| Command | Description |
|---------|-------------|
| `npm install` | Install root migration-script dependencies |
| `npm run install:all` | Install frontend dependencies |
| `npm run build` | TypeScript check + Vite production build |
| `npm run dev` | Vite dev server (proxies /api → emulator) |
| `npm run test` | Frontend Vitest unit tests (94 tests) |
| `npm run test:backend` | Backend integration tests (requires emulators) |
| `npm run typecheck` | TypeScript check only |
| `npm run lint` | ESLint on frontend src |
| `npm run emulate` | Firebase emulators with data persistence |
| `npm run emulate:clean` | Firebase emulators without persisted data |
| `npm run deploy` | Full build + deploy (hosting + functions + rules) |
| `npm run deploy:hosting` | Deploy frontend only |
| `npm run deploy:functions` | Deploy Cloud Function only |
| `npm run deploy:rules` | Deploy Firestore rules + indexes only |
| `npm run backup:supabase` | Backup Supabase → JSON file |
| `npm run import:supabase -- --file <file>` | Import JSON/CSV into Firestore |
| `npm run import:excel -- --file <file>` | Import Excel workbook into Firestore |
| `npm run verify:migration -- --backup <file>` | Verify Firestore matches backup |
| `npm run operator:add -- --email <email>` | Grant operator access |
| `npm run operator:add -- --email <email> --remove` | Revoke operator access |

---

## Deploy to production

```powershell
npm run deploy
```

This runs in order:
1. `npm run build` — TypeScript check + Vite build → `frontend/dist/`
2. `firebase deploy` — deploys:
   - **Hosting**: `frontend/dist/` with `/api/**` rewrite to Cloud Function
   - **Functions**: `functions/main.py` as Python 3.12 Cloud Function
   - **Firestore**: security rules + composite indexes

### Partial deploys

```powershell
npm run deploy:hosting    # Frontend only (fast, no function restart)
npm run deploy:functions  # Cloud Function only
npm run deploy:rules      # Firestore rules + indexes only
```

### After deployment

- Public URL: **https://agingtest-57600.web.app**
- First request after deploy may have 10–30 s cold-start (ONNX model loading).

---

## Data import

### From Supabase (recommended for production migration)

```powershell
# Step 1: Backup Supabase data (reads only, no changes)
$Env:SUPABASE_SERVICE_KEY = "<service_role_key>"
npm run backup:supabase

# Step 2: Dry-run import (safe — prints what would be imported)
npm run import:supabase -- --file backups/supabase_backup_XXXX.json --dry-run

# Step 3: Real import (skips records that already exist)
npm run import:supabase -- --file backups/supabase_backup_XXXX.json

# Step 4: Verify
npm run verify:migration -- --backup backups/supabase_backup_XXXX.json
```

### From Excel workbook

```powershell
# Dry run first
npm run import:excel -- --file "data/aging_test.xlsx" --dry-run

# Real import
npm run import:excel -- --file "data/aging_test.xlsx"
```

The Excel importer reads the hidden **Workflow** sheet to preserve active aging state
(pending_restart, events, next_due, etc.).

### Import guarantees

- Non-destructive: existing Firestore records are **never overwritten**.
- Repeatable: safe to run multiple times.
- Invalid rows are reported clearly; the script exits 1 on any error.

---

## Operator management

```powershell
# Grant operator access
npm run operator:add -- --email alice@example.com

# Revoke operator access
npm run operator:add -- --email alice@example.com --remove
```

Operators must **sign out and back in** after a claim change.

---

## Testing

### Frontend unit tests (no emulators needed)

```powershell
npm run test
# Expected: 94 tests passed (core, camera, photo, live scanner, QR)
```

### Backend integration tests (emulators required)

```powershell
# Terminal 1: Start emulators
npm run emulate:clean

# Terminal 2: Install pytest and run tests
pip install pytest requests
npm run test:backend
# Runs: test_workflow.py, test_ocr_emulator.py, test_auth.py
```

### Test distinction

| Test suite | Emulators needed | Cloud deployment needed |
|------------|-----------------|------------------------|
| `npm run test` (Vitest, 94 tests) | No | No |
| `npm run test:backend` (pytest) | Yes | No |
| OCR with real camera images | Yes + Python deps | No |
| Full E2E with sign-in | Yes | No |
| Production smoke test | No | Yes |

---

## Production migration procedure

> **Do this in a maintenance window of 30–60 minutes.**  
> The live Render/Supabase services remain untouched throughout.

### Pre-migration checklist

- [ ] Blaze billing enabled in Firebase Console
- [ ] Firestore created (Native mode, `us-central1`)
- [ ] Firebase Authentication enabled (Email/Password)
- [ ] `frontend/.env` filled with Firebase config values
- [ ] All operator accounts created + operator claim granted
- [ ] `npm run test` passes locally (94 tests)
- [ ] Firestore rules deployed: `npm run deploy:rules`

### Step-by-step

#### 1. Backup all current data

```powershell
$Env:SUPABASE_SERVICE_KEY = "<your service_role key>"
npm run backup:supabase
# Output: backups/supabase_backup_YYYY-MM-DDTHH-MM-SS.json
```

Keep this file. It is the rollback source.

#### 2. Test import in dry-run mode

```powershell
npm run import:supabase -- --file backups/supabase_backup_XXXX.json --dry-run
```

Confirm the count matches. No errors.

#### 3. Deploy to Firebase (without switching traffic)

```powershell
npm run deploy
```

Verify the deployment at https://agingtest-57600.web.app in a private browser tab.
Sign in as an operator and check the /health and /config endpoints.

#### 4. Pause new submissions on the old system

Coordinate with operators. No new battery scans on Render until step 7.

#### 5. Final Supabase backup (captures records since step 1)

```powershell
npm run backup:supabase --out backups/final
```

#### 6. Import all data to Firestore

```powershell
npm run import:supabase -- --file backups/final/supabase_backup_XXXX.json
```

#### 7. Verify the migration

```powershell
npm run verify:migration -- --backup backups/final/supabase_backup_XXXX.json
# Expected output: "All records match. Migration verified. ✓"
```

If there are mismatches, do NOT switch traffic. Investigate and fix.

#### 8. Switch traffic to Firebase

Update your internal documentation / operator bookmarks to:
- **New URL**: https://agingtest-57600.web.app

The Render service and Supabase database remain running but are no longer used.

#### 9. Monitor for 24 hours

Check Firebase Console for:
- Function invocations and error rate (Functions → Logs)
- Firestore reads/writes (Firestore → Usage)
- Auth sign-ins (Authentication → Users)

#### 10. Decommission old services (after validation)

Once confident:
- Suspend the Render service
- (Optional) Export and archive Supabase data, then pause the project

---

## Rollback procedure

> Rollback preserves all records created or changed **after** switching to Firestore.

### Immediate rollback (< 1 hour after cutover)

1. **Redirect operators back** to the old Render URL.
2. **Export new Firestore records** (created during the Firestore window):

```powershell
# Export current Firestore state to JSON
node -e "
const admin = require('./node_modules/firebase-admin');
admin.initializeApp();
admin.firestore().collection('devices').get()
  .then(snap => {
    const docs = snap.docs.map(d => d.data());
    require('fs').writeFileSync('backups/firestore_rollback_export.json',
      JSON.stringify({ exported_at: new Date().toISOString(), count: docs.length, devices: docs }, null, 2));
    console.log('Exported', docs.length, 'records');
    process.exit(0);
  });
"
```

3. **Import those new records into Supabase** using the Supabase Dashboard or `psql`:
   - Records with `events[0].action === 'register'` and a timestamp after the cutover are new.
   - Import them via the Supabase Table Editor (paste as JSON or use REST API).

4. **Re-enable the Render service** if suspended.

### Reference scripts for rollback

| Script | Purpose |
|--------|---------|
| `backups/supabase_backup_XXXX.json` | Original source of truth before migration |
| `backups/final/supabase_backup_XXXX.json` | Final snapshot before cutover |
| `backups/firestore_rollback_export.json` | Records created in Firestore after cutover |

---

## Troubleshooting

### `npm run deploy` fails with `&&` on PowerShell

```powershell
# Use separate commands instead of &&
npm run build
firebase deploy
```

### "OCR engine still initialising"

The ONNX model compiles on cold start (~30 s). Retry OCR after waiting.  
For the emulator, install Python deps:
```powershell
cd functions
pip install -r requirements.txt
cd ..
```

### "Firebase Functions runtime python312 not available"

Blaze billing plan is required. Enable it in:
> Firebase Console → Project Settings → Usage and billing → Modify plan

### "Firestore permission denied"

The user account is missing the `operator: true` custom claim:
```powershell
npm run operator:add -- --email user@example.com
# User must sign out and back in for the claim to take effect
```

### Sign-in doesn't work in emulator

Make sure the Auth emulator is running (port 9099) and `VITE_FIREBASE_API_KEY` is set in `frontend/.env`.

### "No firebase-admin module"

Run `npm install` in the project root to install devDependencies:
```powershell
npm install
```

### Emulator data doesn't persist between runs

Use `npm run emulate` (not `emulate:clean`) — it imports/exports from `./emulator-data/`.

---

## Firestore data schema

### `devices/{serial_number}`

```json
{
  "serial_number": "T001RABC12345",
  "status": "AGING_HOUR_1",
  "registration_battery": 100,
  "registration_time": "2026-10-01T08:00:00Z",
  "h1_battery": 84, "h1_timestamp": "9:00 AM", "h1_server_time": "...",
  "h2_battery": null, "h2_timestamp": null, "h2_server_time": null,
  "h3_battery": null, "h3_timestamp": null, "h3_server_time": null,
  "h4_battery": null, "h4_timestamp": null, "h4_server_time": null,
  "post_aging_battery": null, "post_aging_timestamp": null, "post_aging_server_time": null,
  "pending_restart": 1,
  "next_checkpoint": 1,
  "aging_started": "2026-10-01T09:00:00Z",
  "next_due": "2026-10-01T10:00:00Z",
  "last_battery": 84,
  "last_device_time": "9:00 AM",
  "last_server_received": "2026-10-01T09:01:00Z",
  "observations": {
    "h1": {"has_issue": "no", "categories": [], "remarks": ""},
    "h2": null, "h3": null, "h4": null, "post": null
  },
  "power_test_result": null,
  "events": [
    {"action": "register", "battery": 100, "device_time": "8:00 AM", "server_received": "..."},
    {"action": "h1", "battery": 84, "device_time": "9:00 AM", "server_received": "..."}
  ]
}
```

### `captures/{token}`

```json
{
  "token": "abc123...",
  "action": "h1",
  "serial_number": "T001RABC12345",
  "created_at": "2026-10-01T09:00:00Z",
  "used": false,
  "revision": "<sha256 of device state at capture time>"
}
```

---

## Business rules preserved

- ✅ Register: battery < 100 → `WAITING_FOR_100_PERCENT_CHARGE`
- ✅ start-aging requires battery = 100
- ✅ H1 shortcut: H1 allowed directly from READY/WAITING state (auto-starts aging)
- ✅ Checkpoints H1→H4 must follow in order; timing check (`next_due`) enforced server-side
- ✅ Operator restart confirmation required after each H1–H4 before next checkpoint proceeds
- ✅ Pending restart blocks further captures on the same device
- ✅ Post-aging: battery ≥ 70% → `PACKING_READY`, else `POST_AGING_CHARGE`
- ✅ Capture tokens: server-generated, 180 s TTL, single-use, bound to action + serial + state revision
- ✅ Token replay rejected (used flag + revision check)
- ✅ Issue categories: Display issue / Crashing or hanging issue / Other issue
- ✅ Power test result: Pass / Fail / Hold
- ✅ Remarks sanitised against formula injection
- ✅ Delete requires operator auth
