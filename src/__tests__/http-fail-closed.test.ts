/**
 * HTTP transport fails closed (CWE-306).
 *
 * Startup refuses to listen when CONDUIT_S2S_SECRET is empty, unless
 * MCP_ALLOW_INSECURE_DEV=1. Gateway-mode /mcp requests without vendor
 * credential headers are 401 and must not consult process.env credentials.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';

const DEV_PORT = 47110;
const REQUEST_PORT = 47111;
const TEST_SECRET = 'test-s2s-fail-closed-secret-do-not-use-in-prod';
const ENV_JWT_SENTINEL = 'env-fallback-sentinel-token';

const exchangeOAuthToken = vi.hoisted(() => vi.fn(async () => 'exchanged-from-headers'));
const getCredentialsSpy = vi.hoisted(() => vi.fn());

vi.mock('../utils/client.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/client.js')>('../utils/client.js');
  return {
    ...actual,
    exchangeOAuthToken,
    getCredentials: () => {
      const creds = actual.getCredentials();
      getCredentialsSpy(creds);
      return creds;
    },
  };
});

const ENV_KEYS = [
  'MCP_TRANSPORT',
  'AUTH_MODE',
  'MCP_HTTP_PORT',
  'MCP_HTTP_HOST',
  'CONDUIT_S2S_SECRET',
  'MCP_ALLOW_INSECURE_DEV',
  'BLUMIRA_JWT_TOKEN',
  'BLUMIRA_CLIENT_ID',
  'BLUMIRA_CLIENT_SECRET',
  'LOG_LEVEL',
] as const;

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function mintS2sHeader(secret: string, unixSeconds = Math.floor(Date.now() / 1000)): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac('sha256', secret).update(message).digest('hex');
  return `${message},v1=${hex}`;
}

async function loadHttpModule(): Promise<void> {
  vi.resetModules();
  await import('../http.js');
}

async function waitForServer(port: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`HTTP server on port ${port} did not become ready`);
}

function captureConsoleError(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  });
  return {
    lines,
    restore: () => spy.mockRestore(),
  };
}

function exitSpy() {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${code}`);
  }) as typeof process.exit);
}

afterAll(() => {
  restoreEnv();
});

describe('HTTP startup fails closed without CONDUIT_S2S_SECRET', () => {
  it('logs an error and exits non-zero when the secret is empty', async () => {
    delete process.env.CONDUIT_S2S_SECRET;
    delete process.env.MCP_ALLOW_INSECURE_DEV;
    process.env.MCP_TRANSPORT = 'http';
    process.env.MCP_HTTP_PORT = '47112';
    process.env.MCP_HTTP_HOST = '127.0.0.1';
    process.env.LOG_LEVEL = 'error';

    const captured = captureConsoleError();
    const exit = exitSpy();
    try {
      await expect(loadHttpModule()).rejects.toThrow('process.exit:1');
      expect(exit).toHaveBeenCalledWith(1);
      const logged = captured.lines.join('\n');
      expect(logged).toContain('Refusing to start HTTP server: CONDUIT_S2S_SECRET is empty.');
      expect(logged).toContain('MCP_ALLOW_INSECURE_DEV=1');
      expect(logged).not.toContain(TEST_SECRET);
    } finally {
      captured.restore();
      exit.mockRestore();
    }

    await expect(fetch('http://127.0.0.1:47112/health')).rejects.toThrow();
  });

  it('still exits when MCP_ALLOW_INSECURE_DEV is not exactly 1', async () => {
    delete process.env.CONDUIT_S2S_SECRET;
    process.env.MCP_ALLOW_INSECURE_DEV = 'true';
    process.env.MCP_TRANSPORT = 'http';
    process.env.MCP_HTTP_PORT = '47113';
    process.env.MCP_HTTP_HOST = '127.0.0.1';
    process.env.LOG_LEVEL = 'error';

    const captured = captureConsoleError();
    const exit = exitSpy();
    try {
      await expect(loadHttpModule()).rejects.toThrow('process.exit:1');
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      captured.restore();
      exit.mockRestore();
    }
  });

  it('starts and logs a warning when MCP_ALLOW_INSECURE_DEV=1', async () => {
    delete process.env.CONDUIT_S2S_SECRET;
    process.env.MCP_ALLOW_INSECURE_DEV = '1';
    process.env.MCP_TRANSPORT = 'http';
    process.env.AUTH_MODE = 'gateway';
    process.env.MCP_HTTP_PORT = String(DEV_PORT);
    process.env.MCP_HTTP_HOST = '127.0.0.1';
    // Warning must stay visible even when warn-level logs are filtered.
    process.env.LOG_LEVEL = 'error';

    const captured = captureConsoleError();
    const exit = exitSpy();
    try {
      await loadHttpModule();
      expect(exit).not.toHaveBeenCalled();
      const logged = captured.lines.join('\n');
      expect(logged).toContain('SECURITY WARNING');
      expect(logged).toContain('MCP_ALLOW_INSECURE_DEV=1');
      expect(logged).toContain('DISABLED');
      expect(logged).not.toContain(TEST_SECRET);
    } finally {
      captured.restore();
      exit.mockRestore();
    }

    await waitForServer(DEV_PORT);
    const health = await fetch(`http://127.0.0.1:${DEV_PORT}/health`);
    expect(health.status).toBe(200);
  });

  it('refuses a known placeholder secret and does not log it', async () => {
    process.env.CONDUIT_S2S_SECRET = 'replace-with-a-real-secret';
    delete process.env.MCP_ALLOW_INSECURE_DEV;
    process.env.MCP_TRANSPORT = 'http';
    process.env.MCP_HTTP_PORT = '47114';
    process.env.MCP_HTTP_HOST = '127.0.0.1';
    process.env.LOG_LEVEL = 'error';

    const captured = captureConsoleError();
    const exit = exitSpy();
    try {
      await expect(loadHttpModule()).rejects.toThrow('process.exit:1');
      expect(exit).toHaveBeenCalledWith(1);
      const logged = captured.lines.join('\n');
      expect(logged).toContain('known placeholder');
      expect(logged).toContain('openssl rand -hex 32');
      expect(logged).not.toContain('replace-with-a-real-secret');
    } finally {
      captured.restore();
      exit.mockRestore();
    }

    await expect(fetch('http://127.0.0.1:47114/health')).rejects.toThrow();
  });

  it('refuses a placeholder even when MCP_ALLOW_INSECURE_DEV=1', async () => {
    process.env.CONDUIT_S2S_SECRET = '  Your-S2S-Secret  ';
    process.env.MCP_ALLOW_INSECURE_DEV = '1';
    process.env.MCP_TRANSPORT = 'http';
    process.env.MCP_HTTP_PORT = '47115';
    process.env.MCP_HTTP_HOST = '127.0.0.1';
    process.env.LOG_LEVEL = 'error';

    const captured = captureConsoleError();
    const exit = exitSpy();
    try {
      await expect(loadHttpModule()).rejects.toThrow('process.exit:1');
      expect(exit).toHaveBeenCalledWith(1);
      expect(captured.lines.join('\n')).not.toContain('Your-S2S-Secret');
    } finally {
      captured.restore();
      exit.mockRestore();
    }
  });

  it('forces 127.0.0.1 when insecure dev is set and the host is loopback or unset', async () => {
    delete process.env.CONDUIT_S2S_SECRET;
    process.env.MCP_ALLOW_INSECURE_DEV = '1';
    process.env.MCP_TRANSPORT = 'http';
    process.env.AUTH_MODE = 'gateway';
    process.env.MCP_HTTP_PORT = '47116';
    process.env.MCP_HTTP_HOST = 'localhost';
    process.env.LOG_LEVEL = 'info';

    const captured = captureConsoleError();
    const exit = exitSpy();
    try {
      await loadHttpModule();
      await waitForServer(47116);
      expect(exit).not.toHaveBeenCalled();
      const logged = captured.lines.join('\n');
      expect(logged).toContain('HTTP streaming server listening on 127.0.0.1:47116');
      expect(logged).not.toContain('listening on localhost');
    } finally {
      captured.restore();
      exit.mockRestore();
    }
  });

  it('refuses insecure dev when MCP_HTTP_HOST is not loopback', async () => {
    delete process.env.CONDUIT_S2S_SECRET;
    process.env.MCP_ALLOW_INSECURE_DEV = '1';
    process.env.MCP_TRANSPORT = 'http';
    process.env.MCP_HTTP_PORT = '47117';
    process.env.MCP_HTTP_HOST = '0.0.0.0';
    process.env.LOG_LEVEL = 'error';

    const captured = captureConsoleError();
    const exit = exitSpy();
    try {
      await expect(loadHttpModule()).rejects.toThrow('process.exit:1');
      expect(exit).toHaveBeenCalledWith(1);
      const logged = captured.lines.join('\n');
      expect(logged).toContain('only binds 127.0.0.1');
      expect(logged).not.toContain(TEST_SECRET);
    } finally {
      captured.restore();
      exit.mockRestore();
    }

    await expect(fetch('http://127.0.0.1:47117/health')).rejects.toThrow();
  });

  it('still honors a non-loopback host when a real secret is set', async () => {
    process.env.CONDUIT_S2S_SECRET = TEST_SECRET;
    delete process.env.MCP_ALLOW_INSECURE_DEV;
    process.env.MCP_TRANSPORT = 'http';
    process.env.AUTH_MODE = 'gateway';
    process.env.MCP_HTTP_PORT = '47118';
    process.env.MCP_HTTP_HOST = '0.0.0.0';
    process.env.LOG_LEVEL = 'info';

    const captured = captureConsoleError();
    const exit = exitSpy();
    try {
      await loadHttpModule();
      await waitForServer(47118);
      expect(exit).not.toHaveBeenCalled();
      const logged = captured.lines.join('\n');
      expect(logged).toContain('HTTP streaming server listening on 0.0.0.0:47118');
      expect(logged).not.toContain(TEST_SECRET);
    } finally {
      captured.restore();
      exit.mockRestore();
    }
  });
});

describe('gateway /mcp auth', () => {
  beforeAll(async () => {
    process.env.MCP_TRANSPORT = 'http';
    process.env.AUTH_MODE = 'gateway';
    process.env.MCP_HTTP_PORT = String(REQUEST_PORT);
    delete process.env.MCP_HTTP_HOST;
    process.env.CONDUIT_S2S_SECRET = TEST_SECRET;
    delete process.env.MCP_ALLOW_INSECURE_DEV;
    process.env.BLUMIRA_JWT_TOKEN = ENV_JWT_SENTINEL;
    delete process.env.BLUMIRA_CLIENT_ID;
    delete process.env.BLUMIRA_CLIENT_SECRET;
    process.env.LOG_LEVEL = 'info';

    const captured = captureConsoleError();
    try {
      await loadHttpModule();
      await waitForServer(REQUEST_PORT);
      const logged = captured.lines.join('\n');
      expect(logged).toContain(`HTTP streaming server listening on 127.0.0.1:${REQUEST_PORT}`);
      expect(logged).not.toContain(TEST_SECRET);
    } finally {
      captured.restore();
    }

    getCredentialsSpy.mockClear();
    exchangeOAuthToken.mockClear();
  });

  async function postMcp(headers: Record<string, string>): Promise<Response> {
    return fetch(`http://127.0.0.1:${REQUEST_PORT}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'blumira_status', arguments: {} },
      }),
    });
  }

  it('serves /health and /healthz without reading credentials', async () => {
    getCredentialsSpy.mockClear();
    for (const path of ['/health', '/healthz']) {
      const res = await fetch(`http://127.0.0.1:${REQUEST_PORT}${path}`);
      expect(res.status).toBe(200);
      const body = await res.json() as { status: string; credentials?: unknown };
      expect(body.status).toBe('ok');
      expect(body.credentials).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain(ENV_JWT_SENTINEL);
    }
    expect(getCredentialsSpy).not.toHaveBeenCalled();
  });

  it('returns 401 when the S2S header is missing', async () => {
    getCredentialsSpy.mockClear();
    exchangeOAuthToken.mockClear();
    const res = await postMcp({ 'x-blumira-jwt-token': 'header-jwt' });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/X-Gateway-S2S/);
    expect(getCredentialsSpy).not.toHaveBeenCalled();
    expect(exchangeOAuthToken).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain(ENV_JWT_SENTINEL);
    expect(JSON.stringify(body)).not.toContain(TEST_SECRET);
  });

  it('returns 401 when the S2S header is invalid', async () => {
    getCredentialsSpy.mockClear();
    exchangeOAuthToken.mockClear();
    const res = await postMcp({
      'x-gateway-s2s': mintS2sHeader('wrong-secret'),
      'x-blumira-client-id': 'header-client',
      'x-blumira-client-secret': 'header-secret',
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/X-Gateway-S2S/);
    expect(getCredentialsSpy).not.toHaveBeenCalled();
    expect(exchangeOAuthToken).not.toHaveBeenCalled();
  });

  it('returns 401 in gateway mode when credential headers are missing and does not use env credentials', async () => {
    getCredentialsSpy.mockClear();
    exchangeOAuthToken.mockClear();
    const res = await postMcp({
      'x-gateway-s2s': mintS2sHeader(TEST_SECRET),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/credential headers/i);
    expect(getCredentialsSpy).not.toHaveBeenCalled();
    expect(exchangeOAuthToken).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain(ENV_JWT_SENTINEL);
    expect(JSON.stringify(body)).not.toContain(TEST_SECRET);
  });

  it('returns 401 when only one OAuth credential header is present', async () => {
    getCredentialsSpy.mockClear();
    const res = await postMcp({
      'x-gateway-s2s': mintS2sHeader(TEST_SECRET),
      'x-blumira-client-id': 'header-client',
    });
    expect(res.status).toBe(401);
    expect(getCredentialsSpy).not.toHaveBeenCalled();
  });

  it('accepts a valid S2S header plus a JWT credential header and does not use env credentials', async () => {
    getCredentialsSpy.mockClear();
    exchangeOAuthToken.mockClear();
    const res = await postMcp({
      'x-gateway-s2s': mintS2sHeader(TEST_SECRET),
      'x-blumira-jwt-token': 'header-jwt-not-the-env-sentinel',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { result: { content: Array<{ text: string }> } };
    const status = JSON.parse(body.result.content[0].text) as { connected: boolean };
    expect(status.connected).toBe(true);
    expect(exchangeOAuthToken).not.toHaveBeenCalled();
    expect(getCredentialsSpy).toHaveBeenCalled();
    const reads = getCredentialsSpy.mock.calls.map((call) => call[0]);
    expect(reads).toContainEqual({
      clientId: '',
      clientSecret: '',
      jwtToken: 'header-jwt-not-the-env-sentinel',
    });
    expect(JSON.stringify(reads)).not.toContain(ENV_JWT_SENTINEL);
    expect(JSON.stringify(body)).not.toContain(TEST_SECRET);
  });

  it('accepts a valid S2S header plus OAuth credential headers', async () => {
    getCredentialsSpy.mockClear();
    exchangeOAuthToken.mockClear();
    const res = await postMcp({
      'x-gateway-s2s': mintS2sHeader(TEST_SECRET),
      'x-blumira-client-id': 'header-client',
      'x-blumira-client-secret': 'header-secret',
    });
    expect(res.status).toBe(200);
    expect(exchangeOAuthToken).toHaveBeenCalledTimes(1);
    expect(exchangeOAuthToken).toHaveBeenCalledWith('header-client', 'header-secret');
    const body = await res.json() as { result: { content: Array<{ text: string }> } };
    const status = JSON.parse(body.result.content[0].text) as { connected: boolean };
    expect(status.connected).toBe(true);
    const reads = getCredentialsSpy.mock.calls.map((call) => call[0]);
    expect(reads).toContainEqual({
      clientId: 'header-client',
      clientSecret: 'header-secret',
      jwtToken: '',
    });
    expect(JSON.stringify(reads)).not.toContain(ENV_JWT_SENTINEL);
  });
});
