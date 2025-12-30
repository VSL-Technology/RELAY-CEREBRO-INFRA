#!/usr/bin/env node
// scripts/test-wireguard-manager.js
// Simple smoke test for wireguardManager in DRY_RUN mode
import wg from '../src/services/wireguardManager.js';

async function run() {
  console.log('DRY_RUN=', process.env.RELAY_DRY_RUN);
  const deviceId = 'test-device-' + Date.now();
  const pub = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa='; // fake base64 -> will fail validation if strict
  const allowed = ['10.0.0.2/32'];

  try {
    console.log('Adding peer (expected in DRY_RUN)');
    const add = await wg.addPeer({ deviceId, publicKey: pub, allowedIps: allowed });
    console.log('add result', add);

    console.log('Listing peers');
    const list = await wg.listPeers();
    console.log('peers', list.slice(0,5));

    console.log('Getting peer by deviceId');
    const peer = await wg.getPeer(deviceId);
    console.log('peer', peer);

    console.log('Removing peer');
    const rem = await wg.removePeer(deviceId);
    console.log('remove result', rem);
  } catch (e) {
    console.error('test error', e && e.message);
    process.exit(1);
  }
}

run();
