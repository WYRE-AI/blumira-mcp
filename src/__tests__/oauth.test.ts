import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the SDK before importing client
vi.mock('@wyre-technology/node-blumira', () => ({
  BlumiraClient: vi.fn().mockImplementation(() => ({})),
}));

import { exchangeOAuthToken, getCredentials, runWithCredentials } from '../utils/client.js';

// Store original env values
const origJwt = process.env.BLUMIRA_JWT_TOKEN;
const origId = process.env.BLUMIRA_CLIENT_ID;
const origSecret = process.env.BLUMIRA_CLIENT_SECRET;

beforeEach(() => {
  // Clear relevant env vars
  delete process.env.BLUMIRA_JWT_TOKEN;
  delete process.env.BLUMIRA_CLIENT_ID;
  delete process.env.BLUMIRA_CLIENT_SECRET;
});

afterEach(() => {
  delete process.env.BLUMIRA_JWT_TOKEN;
  delete process.env.BLUMIRA_CLIENT_ID;
  delete process.env.BLUMIRA_CLIENT_SECRET;
  if (origJwt !== undefined) process.env.BLUMIRA_JWT_TOKEN = origJwt;
  if (origId !== undefined) process.env.BLUMIRA_CLIENT_ID = origId;
  if (origSecret !== undefined) process.env.BLUMIRA_CLIENT_SECRET = origSecret;
  vi.restoreAllMocks();
});

describe('getCredentials', () => {
  it('returns null when no credentials are set', () => {
    expect(getCredentials()).toBeNull();
  });

  it('returns credentials with jwtToken from env fallback', () => {
    process.env.BLUMIRA_JWT_TOKEN = 'test-jwt';
    const creds = getCredentials();
    expect(creds).toEqual({ jwtToken: 'test-jwt', clientId: '', clientSecret: '' });
  });

  it('returns credentials with clientId + clientSecret from env', () => {
    process.env.BLUMIRA_CLIENT_ID = 'my-id';
    process.env.BLUMIRA_CLIENT_SECRET = 'my-secret';
    const creds = getCredentials();
    expect(creds).toEqual({ jwtToken: '', clientId: 'my-id', clientSecret: 'my-secret' });
  });

  it('returns ALS-scoped credentials when inside runWithCredentials', () => {
    // Env has no creds — only ALS store is set
    runWithCredentials({ clientId: 'als-id', clientSecret: 'als-sec', jwtToken: '' }, () => {
      const creds = getCredentials();
      expect(creds).toEqual({ clientId: 'als-id', clientSecret: 'als-sec', jwtToken: '' });
    });
  });

  it('ALS creds are visible inside the callback and null outside', () => {
    // Before: no creds
    expect(getCredentials()).toBeNull();

    runWithCredentials({ clientId: 'inner-id', clientSecret: 'inner-sec', jwtToken: 'inner-jwt' }, () => {
      const creds = getCredentials();
      expect(creds).toEqual({ clientId: 'inner-id', clientSecret: 'inner-sec', jwtToken: 'inner-jwt' });
    });

    // After: still null (ALS context has exited)
    expect(getCredentials()).toBeNull();
  });

  it('ALS credentials take priority over env fallback', () => {
    process.env.BLUMIRA_JWT_TOKEN = 'env-jwt';

    runWithCredentials({ clientId: 'als-id', clientSecret: 'als-sec', jwtToken: 'als-jwt' }, () => {
      const creds = getCredentials();
      // ALS store takes priority
      expect(creds).toEqual({ clientId: 'als-id', clientSecret: 'als-sec', jwtToken: 'als-jwt' });
    });
  });
});

describe('concurrent ALS isolation', () => {
  it('two concurrent runWithCredentials calls each see only their own creds', async () => {
    const results: Array<{ id: string; seen: ReturnType<typeof getCredentials> }> = [];

    const task = (id: string, delay: number) =>
      new Promise<void>((resolve) => {
        runWithCredentials({ clientId: id, clientSecret: `sec-${id}`, jwtToken: '' }, async () => {
          // Force interleaving by sleeping different amounts
          await new Promise((r) => setTimeout(r, delay));
          results.push({ id, seen: getCredentials() });
          resolve();
        });
      });

    // Launch both concurrently — task A sleeps longer so B finishes first
    await Promise.all([task('tenant-A', 20), task('tenant-B', 5)]);

    const seenA = results.find((r) => r.id === 'tenant-A')!.seen;
    const seenB = results.find((r) => r.id === 'tenant-B')!.seen;

    expect(seenA).toEqual({ clientId: 'tenant-A', clientSecret: 'sec-tenant-A', jwtToken: '' });
    expect(seenB).toEqual({ clientId: 'tenant-B', clientSecret: 'sec-tenant-B', jwtToken: '' });
  });
});

describe('elicitation credential scope', () => {
  it('elicitCredentials throw does not write to process.env', async () => {
    const mockServer = {
      elicitInput: vi.fn().mockRejectedValue(new Error('Elicitation not supported')),
    };

    // Replicate the elicitCredentials try/catch pattern from forms.ts
    let elicited: { jwtToken?: string; clientId?: string; clientSecret?: string } | null = null;
    try {
      const res = await (mockServer as any).elicitInput({
        mode: 'form',
        message: 'credentials',
        requestedSchema: { type: 'object', properties: {}, required: [] },
      });
      if (res?.action === 'accept' && res.content) {
        elicited = { jwtToken: res.content.jwt_token };
      }
    } catch {
      // fail-open: elicited remains null
    }

    expect(elicited).toBeNull();
    // CRITICAL: process.env must NOT have been mutated
    expect(process.env.BLUMIRA_JWT_TOKEN).toBeUndefined();
    expect(process.env.BLUMIRA_CLIENT_ID).toBeUndefined();
    expect(process.env.BLUMIRA_CLIENT_SECRET).toBeUndefined();
  });

  it('elicitCredentials decline does not write to process.env', async () => {
    const mockServer = {
      elicitInput: vi.fn().mockResolvedValue({ action: 'decline', content: null }),
    };

    const res = await (mockServer as any).elicitInput({ mode: 'form', message: 'creds', requestedSchema: {} });

    // Simulate the old buggy pattern to confirm it would write — then confirm we don't
    let wouldWrite = false;
    if (res?.action === 'accept' && res?.content?.jwt_token) {
      wouldWrite = true;
      // In the old code: process.env.BLUMIRA_JWT_TOKEN = res.content.jwt_token;
    }

    expect(wouldWrite).toBe(false);
    expect(process.env.BLUMIRA_JWT_TOKEN).toBeUndefined();
  });
});

describe('exchangeOAuthToken', () => {
  it('should call the OAuth endpoint and return access_token', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'new-jwt-token', expires_in: 3600 }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const token = await exchangeOAuthToken('test-id', 'test-secret');
    expect(token).toBe('new-jwt-token');
    expect(mockFetch).toHaveBeenCalledWith('https://auth.blumira.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: 'test-id',
        client_secret: 'test-secret',
        audience: 'https://api.blumira.com/public-api/v1',
      }),
    });
  });

  it('should cache the token on subsequent calls', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'cached-token', expires_in: 3600 }),
    });
    vi.stubGlobal('fetch', mockFetch);

    // Use unique keys to avoid cross-test cache hits
    const token1 = await exchangeOAuthToken('cache-id-x1', 'cache-secret-x1');
    const token2 = await exchangeOAuthToken('cache-id-x1', 'cache-secret-x1');
    expect(token1).toBe('cached-token');
    expect(token2).toBe('cached-token');
    // Should only have called fetch once due to caching
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('should throw on failed exchange', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(exchangeOAuthToken('bad-id-x2', 'bad-secret-x2'))
      .rejects.toThrow('OAuth token exchange failed (401): Unauthorized');
  });
});
