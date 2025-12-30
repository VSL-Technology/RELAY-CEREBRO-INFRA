import { jest } from '@jest/globals';

describe('wireguardManager env requirements', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  it('throws coded error when WG_INTERFACE missing outside dry run', async () => {
    delete process.env.WG_INTERFACE;
    process.env.RELAY_DRY_RUN = '0';
    jest.resetModules();
    const wg = await import('../src/services/wireguardManager.js');
    await expect(wg.listPeers()).rejects.toHaveProperty('code', 'WG_INTERFACE_NOT_CONFIGURED');
  });
});
