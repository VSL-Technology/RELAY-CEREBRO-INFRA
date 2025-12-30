import { jest } from '@jest/globals';

describe('mikrotiks config lazy loading', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  it('does not throw on import without env and errors on use', async () => {
    delete process.env.MIKROTIK_NODES;
    jest.resetModules();
    const mod = await import('../src/config/mikrotiks.js');
    try {
      mod.getMikrotikNodes();
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('MIKROTIK_NODES_NOT_CONFIGURED');
    }
  });

  it('throws coded error on invalid JSON', async () => {
    process.env.MIKROTIK_NODES = '{invalid';
    jest.resetModules();
    const mod = await import('../src/config/mikrotiks.js');
    try {
      mod.getMikrotikNodes();
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('MIKROTIK_NODES_INVALID_JSON');
    }
  });
});
