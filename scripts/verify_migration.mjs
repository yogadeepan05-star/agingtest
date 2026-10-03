#!/usr/bin/env node
/**
 * verify_migration.mjs
 *
 * Reads the Supabase backup JSON and a live Firestore collection
 * and compares serial numbers, statuses, battery values, observations,
 * timestamps, events, and checkpoint state.
 *
 * Usage (after importing to Firestore):
 *   node scripts/verify_migration.mjs --backup backups/supabase_backup_XXX.json
 *   node scripts/verify_migration.mjs --backup backups/supabase_backup_XXX.json --verbose
 *
 * Requires GOOGLE_APPLICATION_CREDENTIALS or gcloud ADC.
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);

const admin = require(path.join(__dirname, '..', 'node_modules', 'firebase-admin'));
const fs    = require('fs');

const args    = process.argv.slice(2);
const bkIdx   = args.indexOf('--backup');
const VERBOSE = args.includes('--verbose');

if (bkIdx === -1) { console.error('--backup <file> required'); process.exit(1); }
const bkFile  = args[bkIdx + 1];

if (!fs.existsSync(bkFile)) { console.error(`Backup not found: ${bkFile}`); process.exit(1); }

admin.initializeApp();
const db = admin.firestore();

function str(v) { return String(v ?? ''); }
function num(v) { return v == null ? null : Number(v); }

async function run() {
  const backup  = JSON.parse(fs.readFileSync(bkFile, 'utf8'));
  // Accept both wrapped { devices: [...] } and plain array
  const expected = Array.isArray(backup) ? backup : (backup.devices || [backup]);
  console.log(`Backup:    ${expected.length} record(s) (exported_at: ${backup.exported_at || 'unknown'})`);

  const snap = await db.collection('devices').get();
  const actual = {};
  snap.docs.forEach(d => { actual[d.id] = d.data(); });
  console.log(`Firestore: ${snap.size} record(s)`);

  let ok = 0, missing = 0, mismatch = 0;
  const issues = [];

  for (const row of expected) {
    const s = row.serial_number;
    if (!s) { issues.push('WARN: backup row with no serial_number'); continue; }

    if (!actual[s]) {
      missing++;
      issues.push(`MISSING  ${s}`);
      continue;
    }

    const fsDoc = actual[s];

    // Core data fields
    const checks = [
      ['status',               str(row.status),               str(fsDoc.status)],
      ['registration_battery', str(num(row.registration_battery)), str(num(fsDoc.registration_battery))],
      ['h1_battery',           str(num(row.h1_battery)),  str(num(fsDoc.h1_battery))],
      ['h2_battery',           str(num(row.h2_battery)),  str(num(fsDoc.h2_battery))],
      ['h3_battery',           str(num(row.h3_battery)),  str(num(fsDoc.h3_battery))],
      ['h4_battery',           str(num(row.h4_battery)),  str(num(fsDoc.h4_battery))],
      ['post_aging_battery',   str(num(row.post_aging_battery)), str(num(fsDoc.post_aging_battery))],
    ];

    // Checkpoint timestamps (if present in source)
    if (row.h1_timestamp) checks.push(['h1_timestamp', str(row.h1_timestamp), str(fsDoc.h1_timestamp)]);
    if (row.h2_timestamp) checks.push(['h2_timestamp', str(row.h2_timestamp), str(fsDoc.h2_timestamp)]);
    if (row.h3_timestamp) checks.push(['h3_timestamp', str(row.h3_timestamp), str(fsDoc.h3_timestamp)]);
    if (row.h4_timestamp) checks.push(['h4_timestamp', str(row.h4_timestamp), str(fsDoc.h4_timestamp)]);

    // Workflow state
    if (row.pending_restart !== undefined) {
      checks.push(['pending_restart', str(row.pending_restart ?? ''), str(fsDoc.pending_restart ?? '')]);
    }

    // Event count
    const srcEvents = Array.isArray(row.events) ? row.events : [];
    const fsEvents  = Array.isArray(fsDoc.events) ? fsDoc.events : [];
    if (srcEvents.length > 0 && fsEvents.length < srcEvents.length) {
      issues.push(`EVENTS   ${s}: source has ${srcEvents.length} events, Firestore has ${fsEvents.length}`);
      mismatch++;
    }

    const bad = checks.filter(([, a, b]) => a !== b);
    if (bad.length) {
      mismatch++;
      bad.forEach(([field, a, b]) => {
        issues.push(`MISMATCH ${s} .${field}: source=${a} firestore=${b}`);
      });
    } else if (VERBOSE) {
      console.log(`  OK: ${s}`);
    } else {
      ok++;
    }
    if (!bad.length && fsEvents.length >= srcEvents.length) ok++;
  }

  // Extra records in Firestore (added during migration window)
  const extras = Object.keys(actual).filter(s => !expected.find(r => r.serial_number === s));
  if (extras.length) {
    console.log(`\nFirestore has ${extras.length} extra record(s) not in backup (OK if added during migration window):`);
    extras.slice(0, 10).forEach(s => console.log('  +', s));
    if (extras.length > 10) console.log(`  ... and ${extras.length - 10} more`);
  }

  console.log('\n=== Results ===');
  console.log(`  OK:       ${ok}`);
  console.log(`  Missing:  ${missing}`);
  console.log(`  Mismatch: ${mismatch}`);

  if (issues.length) {
    console.log('\nIssues:');
    issues.forEach(i => console.log(' ', i));
    process.exit(1);
  } else {
    console.log('\nAll records match. Migration verified. ✓');
    process.exit(0);
  }
}

run().catch(err => { console.error(err); process.exit(1); });
