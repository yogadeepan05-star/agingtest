#!/usr/bin/env node
/**
 * import_from_supabase.mjs
 *
 * Non-destructive import of a Supabase "devices" table CSV or JSON export
 * into Cloud Firestore.
 *
 * Usage:
 *   node scripts/import_from_supabase.mjs --file export.json [--dry-run]
 *   node scripts/import_from_supabase.mjs --file export.csv  [--dry-run]
 *
 * Requirements:
 *   npm install   (installs firebase-admin from root devDependencies)
 *   GOOGLE_APPLICATION_CREDENTIALS  or  gcloud auth application-default login
 *
 * Behaviour:
 *   - Skips records that already exist in Firestore (non-destructive).
 *   - Reports invalid rows (missing serial_number) with WARN.
 *   - Exits 1 if any import error occurred, 0 on success.
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);

// Use local firebase-admin from root devDependencies
const admin = require(path.join(__dirname, '..', 'node_modules', 'firebase-admin'));
const fs    = require('fs');

const args     = process.argv.slice(2);
const DRY_RUN  = args.includes('--dry-run');
const fileArg  = args.indexOf('--file');

if (fileArg === -1) {
  console.error('Usage: node scripts/import_from_supabase.mjs --file <export.json|export.csv> [--dry-run]');
  process.exit(1);
}

const filePath = args[fileArg + 1];
if (!filePath || !fs.existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

admin.initializeApp();
const db = admin.firestore();

function parseFile(fp) {
  const ext = path.extname(fp).toLowerCase();
  if (ext === '.json') {
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
    // Accept both { devices: [...] } wrapper (backup format) and plain array
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw.devices)) return raw.devices;
    return [raw];
  }
  // CSV: first row = headers, handles quoted fields containing commas
  const content = fs.readFileSync(fp, 'utf8');
  const lines = content.split(/\r?\n/);
  const parseCSVRow = (line) => {
    const result = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        result.push(field); field = '';
      } else {
        field += ch;
      }
    }
    result.push(field);
    return result;
  };
  const headers = parseCSVRow(lines[0]).map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = parseCSVRow(line);
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = cols[idx] ?? null; });
    rows.push(obj);
  }
  return rows;
}

function tryNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function tryJSON(v, fallback) {
  if (!v) return fallback;
  if (typeof v !== 'string') return v || fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

function mapRow(row) {
  const obs = tryJSON(row.observations, {});
  return {
    serial_number:        row.serial_number,
    status:               row.status || 'UNKNOWN',
    pending_restart:      row.pending_restart != null ? Number(row.pending_restart) : null,
    next_checkpoint:      tryNum(row.next_checkpoint) ?? 1,
    aging_started:        row.aging_started || null,
    next_due:             row.next_due || null,
    last_server_received: row.last_server_received || new Date().toISOString(),
    last_device_time:     row.last_device_time || null,
    last_battery:         tryNum(row.last_battery),
    registration_time:    row.registration_time || null,
    registration_battery: tryNum(row.registration_battery),
    h1_battery: tryNum(row.h1_battery), h1_timestamp: row.h1_timestamp||null, h1_server_time: row.h1_server_time||null,
    h2_battery: tryNum(row.h2_battery), h2_timestamp: row.h2_timestamp||null, h2_server_time: row.h2_server_time||null,
    h3_battery: tryNum(row.h3_battery), h3_timestamp: row.h3_timestamp||null, h3_server_time: row.h3_server_time||null,
    h4_battery: tryNum(row.h4_battery), h4_timestamp: row.h4_timestamp||null, h4_server_time: row.h4_server_time||null,
    post_aging_battery:     tryNum(row.post_aging_battery),
    post_aging_timestamp:   row.post_aging_timestamp || null,
    post_aging_server_time: row.post_aging_server_time || null,
    observations:         obs,
    power_test_result:    row.power_test_result || null,
    events:               tryJSON(row.events, []),
  };
}

function validateRow(doc, idx) {
  const errors = [];
  if (!doc.serial_number || typeof doc.serial_number !== 'string' || !doc.serial_number.trim()) {
    errors.push(`Row ${idx}: missing or empty serial_number`);
  }
  if (doc.registration_battery !== null && (doc.registration_battery < 0 || doc.registration_battery > 100)) {
    errors.push(`Row ${idx} (${doc.serial_number}): registration_battery out of range`);
  }
  return errors;
}

async function run() {
  let rows;
  try {
    rows = parseFile(filePath);
  } catch (e) {
    console.error(`Failed to parse file: ${e.message}`);
    process.exit(1);
  }

  console.log(`Parsed ${rows.length} record(s) from ${filePath}${DRY_RUN ? ' [DRY RUN]' : ''}`);

  let imported = 0, skipped = 0, warned = 0, errors = 0;
  const allErrors = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const doc = mapRow(row);

    const validationErrors = validateRow(doc, i + 2);
    if (validationErrors.length) {
      validationErrors.forEach(e => console.warn(`  WARN: ${e}`));
      warned++;
      allErrors.push(...validationErrors);
      continue;
    }

    const serial = doc.serial_number.trim();
    const ref  = db.collection('devices').doc(serial);

    try {
      const snap = await ref.get();
      if (snap.exists) {
        console.log(`  SKIP (exists): ${serial}`);
        skipped++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`  DRY-RUN: would import ${serial} (status: ${doc.status})`);
      } else {
        await ref.set(doc);
        console.log(`  IMPORTED: ${serial} (status: ${doc.status})`);
      }
      imported++;
    } catch (e) {
      console.error(`  ERROR importing ${serial}: ${e.message}`);
      errors++;
      allErrors.push(`${serial}: ${e.message}`);
    }
  }

  console.log(`\nDone. Imported: ${imported}, Skipped: ${skipped}, Warned: ${warned}, Errors: ${errors}${DRY_RUN ? ' (dry run)' : ''}`);

  if (allErrors.length) {
    console.log('\nIssues encountered:');
    allErrors.forEach(e => console.log('  -', e));
    process.exit(1);
  }
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
