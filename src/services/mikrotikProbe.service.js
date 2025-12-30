// src/services/mikrotikProbe.service.js
// Probe a MikroTik device over the WireGuard tunnel using mikronode-ng (lazy import)
import net from 'net';
import logger from './logger.js';

const DEFAULT_TIMEOUT = Number(process.env.RELAY_MIKROTIK_PROBE_TIMEOUT_MS || 5000);

function shortError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// small helper to test TCP port open
function checkPortOpen(ip, port = 8728, timeoutMs = DEFAULT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    let done = false;
    const onError = (err) => { if (done) return; done = true; sock.destroy(); reject(err); };
    sock.setTimeout(timeoutMs, () => onError(shortError('timeout', 'tcp connect timeout')));
    sock.once('error', onError);
    sock.connect(port, ip, () => {
      if (done) return;
      done = true;
      sock.end();
      resolve(true);
    });
  });
}

function isDryRun() {
  return process.env.RELAY_DRY_RUN === '1' || process.env.RELAY_DRY_RUN === 'true';
}

// probe using mikronode-ng - lazy import
export async function probeMikrotik({ ip, username, password, timeoutMs = DEFAULT_TIMEOUT }) {
  if (!ip || !username || !password) throw shortError('invalid_payload', 'ip, username and password are required');
  if (isDryRun()) {
    logger.info('mikrotikProbe.dry_run', { ip });
    return { ok: true, api: true, identity: `dry-run-${ip}`, version: '7.0.0-dry', board: 'dryboard', deviceId: null };
  }

  // quick TCP check first to return reachable/unreachable faster
  try {
    await checkPortOpen(ip, 8728, timeoutMs);
  } catch (e) {
    throw shortError('unreachable', `tcp:8728 not reachable on ${ip} (${e && e.message})`);
  }

  // dynamic import of mikronode-ng
  let mod;
  try {
    mod = await import('mikronode-ng');
  } catch (e) {
    throw shortError('dependency_missing', 'mikronode-ng not installed; run `npm i mikronode-ng` to enable Mikrotik probes');
  }

  // Try several common client shapes to stay flexible across versions
  try {
    // Prefer a RouterOS client constructor
    const Client = mod.RouterOSClient || mod.default || mod.MikroNode || mod.MikroApi || mod;

    // The library shapes vary; attempt a few call patterns guarded with timeouts
    const controller = {};

    // Wrap the probe in a timeout
    const probePromise = (async () => {
      // Pattern A: RouterOSClient({ host, port, username, password }) with connect()/close()
      if (typeof Client === 'function') {
        try {
          // attempt to instantiate in the most common ways
          let conn;
          try {
            conn = new Client({ host: ip, port: 8728, username, password });
            if (conn.connect) {
              await conn.connect();
            }
          } catch (e) {
            // fallback patterns
            try {
              conn = new Client(ip, username, password);
              if (conn.connect) await conn.connect();
            } catch (e2) {
              // last ditch: try default export as factory
              conn = await Client.connect ? await Client.connect({ host: ip, username, password }) : null;
            }
          }

          if (!conn) throw new Error('client instantiation failed');

          // try to call /system/identity and /system/resource
          // support both promise and callback styles
          const runCommand = async (cmd) => {
            if (conn.write && typeof conn.write === 'function') {
              // older mikronode: open channel and write
              const ch = conn.openChannel();
              return new Promise((resolve, reject) => {
                ch.on('done', (data) => resolve(data || []));
                ch.on('trap', (t) => reject(new Error('trap')));
                ch.on('error', reject);
                ch.write(cmd);
              });
            }
            if (conn.call && typeof conn.call === 'function') {
              // some libs expose call()
              return await conn.call(cmd);
            }
            if (conn.request && typeof conn.request === 'function') {
              return await conn.request(cmd);
            }
            throw new Error('unsupported client API');
          };

          const identityRes = await runCommand('/system/identity/print');
          const resourceRes = await runCommand('/system/resource/print');

          // attempt to gracefully close
          try { if (conn.close) await conn.close(); if (conn.disconnect) await conn.disconnect(); } catch (e) {}

          // Normalize results (many libs return arrays of objects or nested structures)
          const pickString = (res, key) => {
            try {
              if (!res) return null;
              if (Array.isArray(res)) {
                if (res.length && typeof res[0] === 'object') return res[0][key] || null;
                return res[0] || null;
              }
              if (typeof res === 'object') return res[key] || null;
              return String(res || null);
            } catch (e) { return null; }
          };

          const identity = pickString(identityRes, 'name') || pickString(identityRes, 'identity') || pickString(identityRes, 'system.identity') || null;
          const version = pickString(resourceRes, 'version') || pickString(resourceRes, 'platform') || null;
          const board = pickString(resourceRes, 'board-name') || pickString(resourceRes, 'board') || null;

          return { ok: true, api: true, identity, version, board };
        } catch (err) {
          // pass to outer handler
          throw err;
        }
      }
      throw new Error('unsupported mikronode-ng export');
    })();

    // timeout wrapper
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(shortError('timeout', 'probe timeout')), timeoutMs));
    return await Promise.race([probePromise, timeoutPromise]);
  } catch (e) {
    // classify common errors
    if (e && /auth/i.test(e.message)) throw shortError('auth_failed', 'authentication failed');
    if (e && e.code === 'timeout') throw shortError('timeout', e.message);
    throw shortError('probe_error', e && e.message ? e.message : String(e));
  }
}

export default { probeMikrotik };
