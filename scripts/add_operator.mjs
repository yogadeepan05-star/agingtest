#!/usr/bin/env node
/**
 * add_operator.mjs
 *
 * Sets the `operator: true` custom claim on a Firebase Auth user account.
 * Only users with this claim are permitted to access the API.
 *
 * Usage:
 *   node scripts/add_operator.mjs --email operator@example.com
 *   node scripts/add_operator.mjs --email operator@example.com --remove
 *
 * Requirements:
 *   npm install   (installs firebase-admin from root devDependencies)
 *   GOOGLE_APPLICATION_CREDENTIALS  or  gcloud auth application-default login
 *
 * Or use the npm shortcut:
 *   npm run operator:add -- --email operator@example.com
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);

const admin = require(path.join(__dirname, '..', 'node_modules', 'firebase-admin'));

const args       = process.argv.slice(2);
const emailIdx   = args.indexOf('--email');
const REMOVE     = args.includes('--remove');

if (emailIdx === -1) {
  console.error('Usage: node scripts/add_operator.mjs --email <email> [--remove]');
  process.exit(1);
}

const email = args[emailIdx + 1];
if (!email || !email.includes('@')) {
  console.error('Invalid email address.');
  process.exit(1);
}

admin.initializeApp();

async function run() {
  let user;
  try {
    user = await admin.auth().getUserByEmail(email);
  } catch (e) {
    console.error(`User not found: ${email}`);
    console.error('Make sure the user has signed in at least once to create their account.');
    process.exit(1);
  }

  const currentClaims = user.customClaims || {};
  if (REMOVE) {
    const { operator: _, ...rest } = currentClaims;
    await admin.auth().setCustomUserClaims(user.uid, rest);
    console.log(`✓ Removed operator claim from ${email} (uid: ${user.uid})`);
    console.log('  The user must sign out and sign back in for the change to take effect.');
  } else {
    await admin.auth().setCustomUserClaims(user.uid, { ...currentClaims, operator: true });
    console.log(`✓ Granted operator access to ${email} (uid: ${user.uid})`);
    console.log('  The user must sign out and sign back in for the claim to take effect.');
  }
}

run().catch(err => { console.error(err); process.exit(1); });
