import { createServer as createHttpServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import { runWithCredentials, exchangeOAuthToken } from './utils/client.js';
import type { Credentials } from './utils/client.js';
import { logger } from './utils/logger.js';
import { verifyS2sHeader, S2S_HEADER } from './s2s-verify.js';

// Conduit service-to-service auth (gateway#377 parity). HTTP startup fails
// closed. An empty CONDUIT_S2S_SECRET refuses to boot unless
// MCP_ALLOW_INSECURE_DEV=1, and that bypass binds 127.0.0.1 only. A known
// placeholder secret always refuses to start. When a real secret is set,
// every /mcp request must carry a valid X-Gateway-S2S header. The secret
// value is never logged.
const S2S_SECRET_RAW = (process.env.CONDUIT_S2S_SECRET ?? '').trim();

// Public example values. A copied placeholder must not verify as a real secret.
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  'replace-with-a-real-secret',
  'your-s2s-secret',
  'your-secret',
  'changeme',
  'change-me',
  'placeholder',
  'secret',
  'example',
  'replace-me',
  's2s-secret',
]);

const S2S_SECRET_IS_PLACEHOLDER = KNOWN_PLACEHOLDER_SECRETS.has(S2S_SECRET_RAW.toLowerCase());
const S2S_SECRET = S2S_SECRET_IS_PLACEHOLDER ? '' : S2S_SECRET_RAW;

const MISSING_S2S_SECRET_ERROR =
  'Refusing to start HTTP server: CONDUIT_S2S_SECRET is empty. ' +
  'Set CONDUIT_S2S_SECRET to the gateway-provisioned secret (openssl rand -hex 32), or set MCP_ALLOW_INSECURE_DEV=1 for local development only.';

const PLACEHOLDER_S2S_SECRET_ERROR =
  'Refusing to start HTTP server: CONDUIT_S2S_SECRET is a known placeholder. ' +
  'Generate a secret with `openssl rand -hex 32` and set CONDUIT_S2S_SECRET to that value.';

const INSECURE_DEV_WARNING =
  'SECURITY WARNING: CONDUIT_S2S_SECRET is unset and MCP_ALLOW_INSECURE_DEV=1. ' +
  'HTTP /mcp is starting with service-to-service authentication DISABLED, bound to 127.0.0.1 only. ' +
  'Local development only; do not expose this port.';

const INSECURE_DEV_NON_LOOPBACK_ERROR =
  'Refusing to start HTTP server: MCP_ALLOW_INSECURE_DEV=1 without CONDUIT_S2S_SECRET only binds 127.0.0.1. ' +
  'Unset MCP_HTTP_HOST or set it to 127.0.0.1.';

const LOOPBACK_HOST = '127.0.0.1';

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === 'localhost' || normalized === '::1' || normalized === '[::1]') return true;
  const bare = normalized.startsWith('::ffff:') ? normalized.slice('::ffff:'.length) : normalized;
  const parts = bare.split('.');
  if (parts.length !== 4) return false;
  if (parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  return parts[0] === '127';
}

/** True when startup is the insecure-dev bypass (no real secret). */
function enforceS2sSecretOrExit(): boolean {
  if (S2S_SECRET_IS_PLACEHOLDER) {
    logger.error(PLACEHOLDER_S2S_SECRET_ERROR);
    process.exit(1);
  }
  if (S2S_SECRET) return false;
  if (process.env.MCP_ALLOW_INSECURE_DEV === '1') {
    // error level so LOG_LEVEL=warn|error cannot hide the bypass.
    logger.error(INSECURE_DEV_WARNING);
    return true;
  }
  logger.error(MISSING_S2S_SECRET_ERROR);
  process.exit(1);
}

function resolveBindHost(insecureDev: boolean): string {
  const configured = (process.env.MCP_HTTP_HOST ?? '').trim();
  if (!insecureDev) {
    return configured === '' ? LOOPBACK_HOST : configured;
  }
  if (configured === '' || isLoopbackHost(configured)) return LOOPBACK_HOST;
  logger.error(INSECURE_DEV_NON_LOOPBACK_ERROR);
  process.exit(1);
}

function startHttpServer(): void {
  const insecureDev = enforceS2sSecretOrExit();

  const port = parseInt(process.env.MCP_HTTP_PORT || '8080', 10);
  const host = resolveBindHost(insecureDev);
  const isGatewayMode = process.env.AUTH_MODE === 'gateway';

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    // Shallow, unauthenticated liveness probe. Always 200 while the process is
    // up. Must not read credentials: this route is unauthenticated, and gateway
    // mode has no process-level vendor credentials to report.
    if (url.pathname === '/health' || url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        transport: 'http',
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found', endpoints: ['/mcp', '/health', '/healthz'] }));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }

    // Conduit service-to-service auth (gateway#377 parity): rejected
    // BEFORE any credential extraction or OAuth exchange, mirroring every
    // other ported wrapper (e.g. containers/sentinelone-mcp/gateway_wrapper.py).
    if (S2S_SECRET && !verifyS2sHeader(req.headers[S2S_HEADER] as string | undefined, S2S_SECRET)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.',
        })
      );
      return;
    }

    const handle = async () => {
      const server = createServer();
      // SECURITY-CRITICAL invariant: this transport MUST stay stateless
      // (sessionIdGenerator: undefined + enableJsonResponse: true). Per-request
      // tenant credentials are carried in an AsyncLocalStorage context opened by
      // runWithCredentials() below. A stateless request->single-response flow
      // keeps the tool call inside that context. Switching to a stateful/SSE
      // transport (sessionIdGenerator set, persistent stream) would let a
      // long-lived connection serve later messages under a stale/foreign
      // credential context — re-review tenant isolation before changing this.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    };

    if (isGatewayMode) {
      // Support OAuth headers (preferred) and legacy JWT header
      const clientId = (req.headers['x-blumira-client-id'] as string) || '';
      const clientSecret = (req.headers['x-blumira-client-secret'] as string) || '';
      const jwtToken = (req.headers['x-blumira-jwt-token'] as string) || '';

      if (clientId && clientSecret) {
        // Validate credentials eagerly — fail fast with 401 on bad creds
        try {
          await exchangeOAuthToken(clientId, clientSecret);
        } catch (err) {
          logger.error('OAuth token exchange failed', { error: (err as Error).message });
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'OAuth token exchange failed', detail: (err as Error).message }));
          return;
        }
        const creds: Credentials = { clientId, clientSecret, jwtToken: '' };
        await runWithCredentials(creds, handle);
      } else if (jwtToken) {
        const creds: Credentials = { clientId: '', clientSecret: '', jwtToken };
        await runWithCredentials(creds, handle);
      } else {
        // No vendor credential headers. Do not fall through to process.env:
        // in gateway mode that would let any caller who reached this process
        // use the container's credentials (CWE-306). Same rejection as
        // blackpoint-mcp src/http.ts.
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Unauthorized: missing required gateway credential headers. Provide X-Blumira-Client-ID and X-Blumira-Client-Secret, or X-Blumira-JWT-Token.',
        }));
        return;
      }
    } else {
      await handle();
    }
  });

  httpServer.listen(port, host, () => {
    logger.info(`HTTP streaming server listening on ${host}:${port}`);
  });
}

const transport = process.env.MCP_TRANSPORT;
if (transport === 'http') {
  startHttpServer();
} else {
  import('./index.js');
}
