import { jest } from '@jest/globals';
import { connectToRouter } from '../src/services/mikrotikService.js';

describe('mikrotikService DRY_RUN connectToRouter', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  it('returns stub with exec/close in dry run', async () => {
    process.env.RELAY_DRY_RUN = '1';
    const res = await connectToRouter('10.0.0.1');
    expect(res.ok).toBe(true);
    expect(res.dryRun).toBe(true);
    expect(typeof res.exec).toBe('function');
    await expect(res.exec()).resolves.toHaveProperty('dryRun', true);
    expect(typeof res.close).toBe('function');
    await expect(res.close()).resolves.toBeUndefined();
  });
});
