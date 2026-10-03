#!/usr/bin/env node
/**
 * import_from_excel.mjs
 *
 * Non-destructive import from the legacy Excel workbook into Cloud Firestore.
 *
 * Usage:
 *   node scripts/import_from_excel.mjs [--file path/to/aging_test.xlsx] [--dry-run]
 *
 * Requirements:
 *   npm install   (installs firebase-admin and xlsx from root devDependencies)
 *   GOOGLE_APPLICATION_CREDENTIALS  or  gcloud auth application-default login
 *
 * Excel sheet format (Devices sheet, row 1 = header):
 *   Col 1:  serial_number
 *   Col 2:  registration_time
 *   Col 3:  registration_battery
 *   Col 4-5:  h1_battery, h1_timestamp
 *   Col 6-7:  h2_battery, h2_timestamp
 *   Col 8-9:  h3_battery, h3_timestamp
 *   Col 10-11: h4_battery, h4_timestamp
 *   Col 12-13: post_aging_battery, post_aging_timestamp
 *   Col 14: status
 *   Col 15-17: h1 has_issue, categories, remarks
 *   Col 18-20: h2 has_issue, categories, remarks
 *   Col 21-23: h3 has_issue, categories, remarks
 *   Col 24-26: h4 has_issue, categories, remarks
 *   Col 27-29: post has_issue, categories, remarks
 *   Col 30: power_test_result
 *
 * Workflow sheet (hidden) provides active workflow state (status, pending_restart,
 * next_due, events, etc.) as JSON in column 2. The importer reads it to preserve
 * in-progress aging state.
 *
 * Behaviour:
 *   - Skips records that already exist in Firestore (non-destructive / repeatable).
 *   - Reports invalid/conflicting records clearly.
 *   - Exits 1 on any error.
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);

const XLSX  = require(path.join(__dirname, '..', 'node_modules', 'xlsx'));
const admin = require(path.join(__dirname, '..', 'node_modules', 'firebase-admin'));
const fs    = require('fs');

const args     = process.argv.slice(2);
const DRY_RUN  = args.includes('--dry-run');
const fileArg  = args.indexOf('--file');
const filePath = fileArg !== -1 ? args[fileArg + 1] : path.resolve('data/aging_test.xlsx');

if (!fs.existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

admin.initializeApp();
const db = admin.firestore();

function toIso(val) {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'string' && val.includes('T')) return val;
  // Excel serial date number
  if (typeof val === 'number') {
    const d = XLSX.SSF.parse_date_code(val);
    return new Date(Date.UTC(d.y, d.m - 1, d.d, d.H || 0, d.M || 0, d.S || 0)).toISOString();
  }
  return String(val);
}

function toStr(val) {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  return s || null;
}

function toNum(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  return isNaN(n) ? null : n;
}

function buildObservation(flagCell, catsCell, remarkCell) {
  if (flagCell == null) return null;
  const flag = String(flagCell).trim().toLowerCase();
  const has_issue = flag === 'yes' ? 'yes' : 'no';
  const categories = catsCell ? String(catsCell).split(',').map(s => s.trim()).filter(Boolean) : [];
  const remarks = toStr(remarkCell) || '';
  return { has_issue, categories, remarks };
}

async function run() {
  const wb = XLSX.readFile(filePath);

  const devSheet = wb.Sheets['Devices'];
  if (!devSheet) {
    console.error('Sheet "Devices" not found in workbook. Expected a sheet named "Devices".');
    process.exit(1);
  }

  // Read the hidden Workflow sheet for active state (status, events, etc.)
  const wfSheet = wb.Sheets['Workflow'];
  const workflowMap = {};
  if (wfSheet) {
    const wfRows = XLSX.utils.sheet_to_json(wfSheet, { header: 1, defval: null });
    for (let i = 1; i < wfRows.length; i++) {
      const serial = toStr(wfRows[i][0]);
      if (!serial) continue;
      try {
        const state = JSON.parse(wfRows[i][1] || '{}');
        workflowMap[serial] = state;
      } catch {
        console.warn(`  WARN: Could not parse Workflow JSON for ${serial}`);
      }
    }
    console.log(`Read ${Object.keys(workflowMap).length} workflow record(s) from Workflow sheet.`);
  } else {
    console.log('Note: No "Workflow" sheet found. Active workflow state (pending_restart, events, etc.) will use defaults.');
  }

  const rows = XLSX.utils.sheet_to_json(devSheet, { header: 1, defval: null });
  const header = rows[0] || [];
  console.log(`Devices sheet: ${rows.length - 1} data row(s). Columns: ${header.slice(0, 5).map(String).join(', ')}...`);
  console.log(DRY_RUN ? '[DRY RUN — no writes]' : '[LIVE RUN]');

  let imported = 0, skipped = 0, warned = 0, errors = 0;
  const allIssues = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[0]) continue;

    const serial = toStr(r[0]);
    if (!serial) {
      console.warn(`  WARN: Row ${i + 1}: empty serial_number, skipping`);
      warned++;
      allIssues.push(`Row ${i + 1}: empty serial_number`);
      continue;
    }

    const wf = workflowMap[serial] || {};

    const doc = {
      serial_number:        serial,
      registration_time:    toIso(r[1]),
      registration_battery: toNum(r[2]),
      h1_battery:   toNum(r[3]),  h1_timestamp:   toStr(r[4]),   h1_server_time: null,
      h2_battery:   toNum(r[5]),  h2_timestamp:   toStr(r[6]),   h2_server_time: null,
      h3_battery:   toNum(r[7]),  h3_timestamp:   toStr(r[8]),   h3_server_time: null,
      h4_battery:   toNum(r[9]),  h4_timestamp:   toStr(r[10]),  h4_server_time: null,
      post_aging_battery:     toNum(r[11]),
      post_aging_timestamp:   toStr(r[12]),
      post_aging_server_time: null,
      // Status from Devices sheet (col 14), falling back to Workflow sheet
      status:          toStr(r[13]) || wf.status || 'UNKNOWN',
      observations: {
        h1:   buildObservation(r[14], r[15], r[16]),
        h2:   buildObservation(r[17], r[18], r[19]),
        h3:   buildObservation(r[20], r[21], r[22]),
        h4:   buildObservation(r[23], r[24], r[25]),
        post: buildObservation(r[26], r[27], r[28]),
      },
      power_test_result: toStr(r[29]),
      // Workflow state: prefer Workflow sheet values over defaults
      pending_restart: wf.pending_restart ?? null,
      next_checkpoint: wf.next_checkpoint ?? 1,
      aging_started:   wf.aging_started   ?? null,
      next_due:        wf.next_due        ?? null,
      events:          wf.events          ?? [{ action: 'imported_from_excel', server_received: new Date().toISOString() }],
      last_battery:    wf.last_battery    ?? toNum(r[11]) ?? toNum(r[9]) ?? toNum(r[7]) ?? toNum(r[5]) ?? toNum(r[3]) ?? toNum(r[2]),
      last_device_time:    wf.last_device_time    ?? null,
      last_server_received: new Date().toISOString(),
    };

    const ref  = db.collection('devices').doc(serial);

    try {
      const snap = await ref.get();
      if (snap.exists) {
        console.log(`  SKIP (exists): ${serial}`);
        skipped++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`  DRY-RUN: would import ${serial} (status: ${doc.status}, events: ${doc.events.length})`);
      } else {
        await ref.set(doc);
        console.log(`  IMPORTED: ${serial} (status: ${doc.status})`);
      }
      imported++;
    } catch (e) {
      console.error(`  ERROR importing ${serial}: ${e.message}`);
      errors++;
      allIssues.push(`${serial}: ${e.message}`);
    }
  }

  console.log(`\nDone. Imported: ${imported}, Skipped: ${skipped}, Warned: ${warned}, Errors: ${errors}${DRY_RUN ? ' (dry run)' : ''}`);

  if (allIssues.length) {
    console.log('\nIssues:');
    allIssues.forEach(i => console.log('  -', i));
    process.exit(1);
  }
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
