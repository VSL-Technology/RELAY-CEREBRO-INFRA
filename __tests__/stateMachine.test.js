let processEvent;

describe('stateMachine validation', () => {
  beforeAll(async () => {
    process.env.RELAY_DRY_RUN = '1';
    process.env.MIKROTIK_NODES = '[{"id":"LOPESUL-HOTSPOT-06","host":"127.0.0.1","user":"u","pass":"p","port":8728}]';
    const mod = await import('../src/services/stateMachine.js');
    processEvent = mod.processEvent;
  });

  it('rejects trial without mac', async () => {
    const res = await processEvent({
      eventId: 'evt-missing-mac',
      type: 'TRIAL_REQUESTED',
      payload: { mikId: 'LOPESUL-HOTSPOT-06', ip: '10.0.0.1' },
      timestamp: Date.now()
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('validation');
  });

  it('accepts trial with required fields', async () => {
    const res = await processEvent({
      eventId: 'evt-valid-trial',
      type: 'TRIAL_REQUESTED',
      payload: { mikId: 'LOPESUL-HOTSPOT-06', ip: '10.0.0.2', mac: 'AA:BB:CC:DD:EE:FF', pedidoId: '123' },
      timestamp: Date.now()
    });
    expect(res.ok).toBe(true);
  });
});
