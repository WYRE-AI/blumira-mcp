import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the SDK before importing client.
// Use a class expression so `new BlumiraClient(...)` works in tests that call getClient().
vi.mock('@wyre-technology/node-blumira', () => ({
  BlumiraClient: vi.fn().mockImplementation(function () { return {}; }),
}));

import { BlumiraClient } from '@wyre-technology/node-blumira';
import { exchangeOAuthToken, getCredentials, runWithCredentials, getClient } from '../utils/client.js';
import { elicitCredentials } from '../elicitation/forms.js';

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

// Fix 1: Drive the REAL elicitCredentials from forms.ts — not an inline copy.
// These tests detect process.env mutations introduced back into the call chain.
describe('elicitation credential scope (real elicitCredentials)', () => {
  it('Test A: elicitInput throws → elicitCredentials returns null, no process.env mutation', async () => {
    const fakeServer = {
      elicitInput: vi.fn().mockRejectedValue(new Error('not supported')),
    };

    // Call the REAL exported function — not a copy
    const result = await elicitCredentials(fakeServer as any);

    expect(result).toBeNull();
    // If any code in the call chain wrote to process.env, these would catch it
    expect(process.env.BLUMIRA_JWT_TOKEN).toBeUndefined();
    expect(process.env.BLUMIRA_CLIENT_ID).toBeUndefined();
    expect(process.env.BLUMIRA_CLIENT_SECRET).toBeUndefined();
  });

  it('Test B: elicitInput resolves with decline → elicitCredentials returns null, no process.env mutation', async () => {
    const fakeServer = {
      elicitInput: vi.fn().mockResolvedValue({ action: 'decline', content: null }),
    };

    const result = await elicitCredentials(fakeServer as any);

    expect(result).toBeNull();
    expect(process.env.BLUMIRA_JWT_TOKEN).toBeUndefined();
    expect(process.env.BLUMIRA_CLIENT_ID).toBeUndefined();
    expect(process.env.BLUMIRA_CLIENT_SECRET).toBeUndefined();
  });

  it('Test C: elicitInput accept with jwt_token → elicitCredentials returns value, process.env STILL unset', async () => {
    const fakeServer = {
      elicitInput: vi.fn().mockResolvedValue({
        action: 'accept',
        content: { jwt_token: 'elicited-jwt' },
      }),
    };

    const result = await elicitCredentials(fakeServer as any);

    // The real function DOES return the elicited value
    expect(result).toEqual({ jwtToken: 'elicited-jwt' });
    // But elicitCredentials itself must NEVER write to process.env
    // (the env-write bug was in the OLD server.ts caller, now removed)
    expect(process.env.BLUMIRA_JWT_TOKEN).toBeUndefined();
    expect(process.env.BLUMIRA_CLIENT_ID).toBeUndefined();
    expect(process.env.BLUMIRA_CLIENT_SECRET).toBeUndefined();
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

// Fix 3: getClient() reads ALS-scoped credentials, not env
describe('getClient() reads ALS-scoped credentials', () => {
  it('uses ALS-scoped jwtToken to construct BlumiraClient', async () => {
    vi.mocked(BlumiraClient).mockClear();

    await runWithCredentials({ clientId: '', clientSecret: '', jwtToken: 'scoped-jwt' }, async () => {
      await getClient();
    });

    expect(vi.mocked(BlumiraClient)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(BlumiraClient)).toHaveBeenCalledWith({ jwtToken: 'scoped-jwt' });
  });

  it('uses ALS-scoped OAuth creds to exchange token then construct BlumiraClient', async () => {
    vi.mocked(BlumiraClient).mockClear();

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'exchanged-token', expires_in: 3600 }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await runWithCredentials({ clientId: 'cid', clientSecret: 'csec', jwtToken: '' }, async () => {
      await getClient();
    });

    expect(vi.mocked(BlumiraClient)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(BlumiraClient)).toHaveBeenCalledWith({ jwtToken: 'exchanged-token' });
  });
});
