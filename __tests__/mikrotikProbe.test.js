import { probeMikrotik } from '../src/services/mikrotikProbe.service.js';

describe('mikrotik probe (DRY_RUN)', () => {
  beforeAll(() => { process.env.RELAY_DRY_RUN = '1'; });
  it('returns mocked probe result', async () => {
    const result = await probeMikrotik({ ip: '10.200.1.5', username: 'admin', password: 'fake' });
    expect(result.ok).toBe(true);
    expect(result.identity).toBeDefined();
  });
});
