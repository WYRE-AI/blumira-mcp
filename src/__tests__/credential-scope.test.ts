import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the jwtToken each BlumiraClient is constructed with so we can prove
// getClient() builds from the request-scoped credentials — not a shared slot.
const constructed: string[] = [];
vi.mock('@wyre-technology/node-blumira', () => ({
  BlumiraClient: vi.fn().mockImplementation((cfg: { jwtToken: string }) => {
    constructed.push(cfg.jwtToken);
    return { jwtToken: cfg.jwtToken };
  }),
}));

import { getClient, getCredentials, runWithCredentials } from '../utils/client.js';

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.BLUMIRA_JWT_TOKEN;
  delete process.env.BLUMIRA_CLIENT_ID;
  delete process.env.BLUMIRA_CLIENT_SECRET;
  constructed.length = 0;
  // Clear recorded calls but keep the module mock's implementation intact
  // (vi.restoreAllMocks would strip the factory's mockImplementation).
  vi.clearAllMocks();
});

describe('request-scoped credentials (AsyncLocalStorage)', () => {
  it('prefers request-scoped credentials over process.env', () => {
    process.env.BLUMIRA_JWT_TOKEN = 'env-token';
    const scoped = runWithCredentials({ jwtToken: 'scoped-token' }, () => getCredentials());
    expect(scoped).toEqual({ jwtToken: 'scoped-token' });
    // Outside the scope, getCredentials() falls back to process.env.
    expect(getCredentials()).toEqual({ jwtToken: 'env-token' });
  });

  it('builds a client from the request-scoped jwtToken', async () => {
    const client = (await runWithCredentials({ jwtToken: 'tenant-a' }, () =>
      getClient(),
    )) as unknown as { jwtToken: string };
    expect(client.jwtToken).toBe('tenant-a');
    expect(constructed).toEqual(['tenant-a']);
  });

  it('isolates credentials across concurrent tenants (no cross-tenant leak)', async () => {
    // Each tenant awaits (interleaving the event loop) before building its
    // client. Under the old process.env + singleton approach the slower tenant
    // would read the faster tenant's token; ALS keeps them isolated.
    const build = (token: string, delayMs: number) =>
      runWithCredentials({ jwtToken: token }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        const client = (await getClient()) as unknown as { jwtToken: string };
        return client.jwtToken;
      });

    const [a, b] = await Promise.all([build('tenant-a', 20), build('tenant-b', 5)]);
    expect(a).toBe('tenant-a');
    expect(b).toBe('tenant-b');
    expect(constructed.sort()).toEqual(['tenant-a', 'tenant-b']);
  });
});
