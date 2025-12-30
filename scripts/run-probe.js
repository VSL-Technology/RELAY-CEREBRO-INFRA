#!/usr/bin/env node
// scripts/run-probe.js
// Simple helper to POST to the internal mikrotik probe endpoint.
// Usage:
//   node scripts/run-probe.js --publicKey AAA --username relay-tech --password secret --token internal --host http://127.0.0.1:3001

import fetch from 'node-fetch';

function usage() {
  console.log('Usage: node scripts/run-probe.js --publicKey <pk> --username <user> --password <pwd> [--token <internal-token>] [--host <url>]');
  process.exit(1);
}

const argv = process.argv.slice(2);
const opts = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--publicKey') opts.publicKey = argv[++i];
  else if (a === '--username') opts.username = argv[++i];
  else if (a === '--password') opts.password = argv[++i];
  else if (a === '--token') opts.token = argv[++i];
  else if (a === '--host') opts.host = argv[++i];
}

opts.token = opts.token || process.env.RELAY_INTERNAL_TOKEN || 'internal';
opts.host = opts.host || process.env.RELAY_HOST || 'http://127.0.0.1:3001';

if (!opts.publicKey || !opts.username || !opts.password) usage();

const url = `${opts.host.replace(/\/$/, '')}/internal/mikrotik/probe`;

(async () => {
  try {
    console.log(`PROBE -> ${url}`);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-relay-internal-token': opts.token
      },
      body: JSON.stringify({ publicKey: opts.publicKey, username: opts.username, password: opts.password })
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch (e) { body = text; }
    console.log('HTTP', res.status, res.statusText);
    console.log('BODY:', JSON.stringify(body, null, 2));
    if (!res.ok) process.exit(2);
  } catch (e) {
    console.error('probe failed:', e && e.message);
    process.exit(3);
  }
})();
