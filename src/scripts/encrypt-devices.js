#!/usr/bin/env node
// src/scripts/encrypt-devices.js
// One-shot migration: encrypts plaintext apiPassword fields in data/devices.json
// Usage: RELAY_MASTER_KEY=<key> node src/scripts/encrypt-devices.js
import '../bootstrap/env.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { encryptSecret } from '../lib/secrets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.resolve(__dirname, '../../data/devices.json');

const masterKey = process.env.RELAY_MASTER_KEY;
if (!masterKey) {
  console.error('[encrypt-devices] ERROR: RELAY_MASTER_KEY env is required.');
  process.exit(1);
}

if (!fs.existsSync(DATA_FILE)) {
  console.log('[encrypt-devices] data/devices.json not found — nothing to migrate.');
  process.exit(0);
}

const raw = fs.readFileSync(DATA_FILE, 'utf8');
let devices;
try {
  devices = JSON.parse(raw);
} catch (e) {
  console.error('[encrypt-devices] ERROR: could not parse devices.json:', e.message);
  process.exit(1);
}

if (!Array.isArray(devices)) {
  console.error('[encrypt-devices] ERROR: devices.json is not an array.');
  process.exit(1);
}

let migrated = 0;
const updated = devices.map((device) => {
  const pwd = device.meta && device.meta.mikrotik && device.meta.mikrotik.apiPassword;
  if (pwd && !String(pwd).startsWith('enc:')) {
    device.meta.mikrotik.apiPassword = encryptSecret(pwd, masterKey);
    migrated++;
  }
  return device;
});

const tmp = DATA_FILE + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(updated, null, 2), 'utf8');
fs.renameSync(tmp, DATA_FILE);

console.log(`[encrypt-devices] Done. ${migrated} password(s) encrypted. File: ${DATA_FILE}`);
