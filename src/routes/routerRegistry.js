// Endpoint dedicado para registrar Mikrotik/WG via backend UI.
import express from 'express';
import relayManager from '../services/relayManager.js';
import peerBinding from '../services/peerBinding.service.js';
import { RelayError } from '../services/errors.js';
import logger from '../services/logger.js';

const router = express.Router();

// Body esperado: { deviceId, mikrotikPublicKey, tunnelIp, allowedIps?, endpoint?, keepalive?, presharedKey?, mikrotik: { publicIp, apiUser, apiPassword, apiPort? } }
router.post('/routers/register', async (req, res) => {
  try {
    const body = req.body || {};
    const { deviceId, mikrotikPublicKey, tunnelIp, allowedIps, endpoint, keepalive, presharedKey, mikrotik = {} } = body;
    if (!deviceId || !mikrotikPublicKey || !tunnelIp || !mikrotik.publicIp || !mikrotik.apiUser || !mikrotik.apiPassword) {
      return res.status(400).json({ ok: false, code: 'invalid_payload', message: 'deviceId, mikrotikPublicKey, tunnelIp, mikrotik.publicIp, mikrotik.apiUser, mikrotik.apiPassword são obrigatórios' });
    }

    const allowed = allowedIps || `${tunnelIp}/32`;

    // register peer and metadata (do not store apiPassword)
    const reg = await relayManager.provisionDevice({
      deviceId,
      publicKey: mikrotikPublicKey,
      allowedIps: allowed,
      tunnelIp,
      endpoint,
      keepalive,
      presharedKey,
      meta: {
        mikrotik: {
          publicIp: mikrotik.publicIp,
          apiUser: mikrotik.apiUser,
          apiPort: mikrotik.apiPort || 8728
        },
        tunnelIp
      }
    });

    // bind publicKey->deviceId/mikrotikIp for status endpoints
    try {
      await peerBinding.bindPeer({ publicKey: mikrotikPublicKey, deviceId, mikrotikIp: mikrotik.publicIp });
    } catch (e) {
      logger.warn('router.register.binding_error', { message: e && e.message });
    }

    return res.json({ ok: true, deviceId: reg.deviceId, tunnelIp, allowedIps: allowed });
  } catch (e) {
    if (e instanceof RelayError) return res.status(e.status).json({ ok: false, code: e.code, message: e.message });
    logger.error('router.register.unhandled', { message: e && e.message });
    return res.status(500).json({ ok: false, code: 'internal_error', message: e && e.message });
  }
});

// Remove peer
router.delete('/routers/:id', async (req, res) => {
  try {
    const deviceId = req.params.id;
    const result = await relayManager.deprovisionDevice(deviceId);
    try {
      const bindings = await peerBinding.listBindings();
      const found = bindings.find((b) => b.deviceId === deviceId);
      if (found && found.publicKey) await peerBinding.unbindPeer(found.publicKey);
    } catch (e) {
      logger.warn('router.unregister.binding_error', { message: e && e.message });
    }
    return res.json(result);
  } catch (e) {
    if (e instanceof RelayError) return res.status(e.status).json({ ok: false, code: e.code, message: e.message });
    logger.error('router.unregister.unhandled', { message: e && e.message });
    return res.status(500).json({ ok: false, code: 'internal_error', message: e && e.message });
  }
});

export default router;
