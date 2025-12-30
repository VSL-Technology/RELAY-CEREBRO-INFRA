import { applyMinimalConfig, ensureTechnicalUser } from '../src/services/mikrotikService.js';

describe('mikrotikService (DRY_RUN)', () => {
  beforeAll(() => {
    process.env.RELAY_DRY_RUN = '1';
  });

  it('builds idempotent commands for minimal config', async () => {
    const res = await applyMinimalConfig('10.0.0.1', { tunnelIp: '10.200.1.10', vpsPublicKey: 'PUB', vpsEndpoint: 'endpoint:51820' });
    expect(res.ok).toBe(true);
    expect(res.commands).toBeDefined();
    expect(res.commands.join('\n')).toContain('interface=wg-relay');
  });

  it('builds user creation commands', async () => {
    const res = await ensureTechnicalUser('10.0.0.1', { username: 'relay-tech', password: 'secret' });
    expect(res.ok).toBe(true);
    expect(res.commands).toBeDefined();
    expect(res.commands[0]).toContain('relay-tech');
  });

  it('fails when tunnel data missing', async () => {
    const res = await applyMinimalConfig('10.0.0.1', {});
    expect(res.ok).toBe(false);
    expect(res.error).toContain('tunnel');
  });

  it('fails when vps pub missing', async () => {
    const res = await applyMinimalConfig('10.0.0.1', { tunnelIp: '10.200.1.10' });
    expect(res.ok).toBe(false);
  });

  it('fails when user password missing', async () => {
    const res = await ensureTechnicalUser('10.0.0.1', { username: 'relay-tech' });
    expect(res.ok).toBe(false);
  });
});
