/**
 * Instrumented call-counter probe for the S2S guard ordering invariant
 * (boss's ordering-catch rule, 2026-07-28 S2S rollout evidence report).
 *
 * A generic 4-case grant/deny test proves the guard rejects/accepts, but not
 * ORDERING — a sibling whose credential-read has a side effect (here:
 * exchangeOAuthToken(), a real outbound OAuth call) could still have that
 * side effect fire on a rejected request if the guard were ever moved after
 * it. This test spins up the real HTTP handler (src/http.ts) with
 * exchangeOAuthToken mocked, and asserts it is called exactly ZERO times
 * when the S2S guard rejects a request, and exactly ONCE when the guard
 * accepts one (negative control — proves the counter can actually detect
 * the exchange firing, not just that it never runs at all).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';

const TEST_PORT = 47001;
const TEST_SECRET = 'test-s2s-guard-ordering-secret-do-not-use-in-prod';

const exchangeOAuthToken = vi.fn(async () => {
  // Deliberately reject so the mocked call never proceeds into the real
  // MCP/transport code this test isn't exercising — the guard-ordering
  // question is fully answered by whether this mock was CALLED, not by
  // what it resolves to.
  throw new Error('s2s-guard-ordering-test: mock exchange reached, count recorded');
});

vi.mock('../utils/client.js', () => ({
  exchangeOAuthToken,
  runWithCredentials: (_creds: unknown, fn: () => unknown) => fn(),
  getCredentials: () => null,
}));

function mintS2sHeader(secret: string, unixSeconds: number): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac('sha256', secret).update(message).digest('hex');
  return `${message},v1=${hex}`;
}

async function postToMcp(headers: Record<string, string>): Promise<Response> {
  return fetch(`http://127.0.0.1:${TEST_PORT}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
  });
}

async function waitForServerReady(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error('blumira-mcp test HTTP server did not become ready in time');
}

beforeAll(async () => {
  process.env.MCP_TRANSPORT = 'http';
  process.env.AUTH_MODE = 'gateway';
  process.env.MCP_HTTP_PORT = String(TEST_PORT);
  process.env.MCP_HTTP_HOST = '127.0.0.1';
  process.env.CONDUIT_S2S_SECRET = TEST_SECRET;
  await import('../http.js');
  await waitForServerReady();
});

afterAll(() => {
  // http.ts does not export the server handle to close it explicitly;
  // the process exits with the vitest worker, which tears the listener
  // down. Nothing to do here beyond documenting why.
});

describe('S2S guard ordering vs. OAuth exchange side effect (blumira-mcp)', () => {
  it('does NOT call exchangeOAuthToken when the S2S header is missing', async () => {
    exchangeOAuthToken.mockClear();
    const res = await postToMcp({
      'x-blumira-client-id': 'test-client',
      'x-blumira-client-secret': 'test-secret',
    });
    expect(res.status).toBe(401);
    expect(exchangeOAuthToken).not.toHaveBeenCalled();
  });

  it('does NOT call exchangeOAuthToken when the S2S header is present but invalid', async () => {
    exchangeOAuthToken.mockClear();
    const res = await postToMcp({
      'x-gateway-s2s': mintS2sHeader('wrong-secret', Math.floor(Date.now() / 1000)),
      'x-blumira-client-id': 'test-client',
      'x-blumira-client-secret': 'test-secret',
    });
    expect(res.status).toBe(401);
    expect(exchangeOAuthToken).not.toHaveBeenCalled();
  });

  it('DOES call exchangeOAuthToken exactly once once the S2S guard accepts the request (negative control)', async () => {
    exchangeOAuthToken.mockClear();
    const res = await postToMcp({
      'x-gateway-s2s': mintS2sHeader(TEST_SECRET, Math.floor(Date.now() / 1000)),
      'x-blumira-client-id': 'test-client',
      'x-blumira-client-secret': 'test-secret',
    });
    // Mock is designed to reject, which http.ts's own catch block turns into
    // a controlled 401 — the response code isn't the point here, the call
    // count is.
    expect(res.status).toBe(401);
    expect(exchangeOAuthToken).toHaveBeenCalledTimes(1);
  });
});
