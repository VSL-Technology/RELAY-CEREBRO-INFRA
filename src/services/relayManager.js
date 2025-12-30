// src/services/relayManager.js
import logger from './logger.js';
import deviceRegistry from '../registry/deviceRegistry.js';
import * as wg from './wireguardManager.js';
import mikrotik from './mikrotikService.js';
import { RelayError } from './errors.js';

class RelayManager {
  constructor() {}

  async provisionDevice(payload = {}) {
    // validate payload
    const { deviceId, publicKey, allowedIps, tunnelIp, meta, endpoint, keepalive, presharedKey } = payload || {};
    if (!publicKey || !allowedIps) throw new RelayError('invalid_payload', 'invalid_payload', 400);

    // idempotent register
    const rec = deviceRegistry.registerDevice({ deviceId, publicKey, allowedIps, meta: { ...meta, endpoint, keepalive, presharedKey } });

    // ensure wg peer exists
    await wg.addPeer({ deviceId: rec.deviceId, publicKey: rec.publicKey, allowedIps: rec.allowedIps, endpoint, keepalive, presharedKey });

    // optionally validate mikrotik via tunnel ip
    if (tunnelIp) {
      const status = await mikrotik.validateIdentity(tunnelIp);
      if (status && status.status !== 'ONLINE') {
        logger.warn('relayManager.provisionDevice.mikrotik_not_online', { deviceId: rec.deviceId, status });
      }
    }

    deviceRegistry.updateDeviceStatus(rec.deviceId, 'provisioned', { tunnelIp });
    logger.info('relayManager.provisioned', { deviceId: rec.deviceId });
    return { ok: true, deviceId: rec.deviceId };
  }

  async deprovisionDevice(deviceId) {
    const rec = deviceRegistry.getDevice(deviceId);
    if (!rec) throw new RelayError('not_found', 'device_not_found', 404);
    await wg.removePeer(deviceId);
    deviceRegistry.updateDeviceStatus(deviceId, 'deprovisioned');
    logger.info('relayManager.deprovisioned', { deviceId });
    return { ok: true };
  }

  async syncDevice(deviceId) {
    const rec = deviceRegistry.getDevice(deviceId);
    if (!rec) throw new RelayError('not_found', 'device_not_found', 404);
    // re-ensure peer exists and mikrotik config applied if tunnelIp present
    await wg.addPeer({ deviceId: rec.deviceId, publicKey: rec.publicKey, allowedIps: rec.allowedIps });
    if (rec.meta && rec.meta.tunnelIp) {
      await mikrotik.applyMinimalConfig(rec.meta.tunnelIp, rec.meta.config || {});
    }
    deviceRegistry.updateDeviceStatus(deviceId, 'synced');
    logger.info('relayManager.synced', { deviceId });
    return { ok: true };
  }

  async healthCheck(deviceId) {
    const rec = deviceRegistry.getDevice(deviceId);
    if (!rec) throw new RelayError('not_found', 'device_not_found', 404);
    const peers = await wg.listPeers();
    const hasPeer = peers.includes(rec.publicKey);
    let mikStatus = { status: 'UNKNOWN' };
    if (rec.meta && rec.meta.tunnelIp) mikStatus = await mikrotik.validateIdentity(rec.meta.tunnelIp);
    return { ok: true, device: rec, hasPeer, mikStatus };
  }
}

export default new RelayManager();
