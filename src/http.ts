import { createServer as createHttpServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import {
  getCredentials,
  runWithCredentials,
  exchangeOAuthToken,
  type Credentials,
} from './utils/client.js';
import { logger } from './utils/logger.js';

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function startHttpServer(): void {
  const port = parseInt(process.env.MCP_HTTP_PORT || '8080', 10);
  const host = process.env.MCP_HTTP_HOST || '0.0.0.0';
  const isGatewayMode = process.env.AUTH_MODE === 'gateway';

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/health') {
      const creds = getCredentials();
      const statusCode = creds ? 200 : 503;
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: creds ? 'ok' : 'degraded',
        transport: 'http',
        credentials: { configured: !!creds },
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found', endpoints: ['/mcp', '/health'] }));
      return;
    }

    // Resolve this request's tenant credentials from gateway headers into a
    // request-local — NEVER process.env. A global env write races across
    // concurrent tenants: request B overwrites request A's token between A's
    // await points, so A's tool call reads B's credentials. These locals are
    // handed to runWithCredentials() below so the tool call reads them from an
    // AsyncLocalStorage context scoped to this request alone.
    let scopedCreds: Credentials | null = null;
    if (isGatewayMode) {
      // Support new OAuth headers (preferred) and legacy JWT header
      const clientId = req.headers['x-blumira-client-id'] as string | undefined;
      const clientSecret = req.headers['x-blumira-client-secret'] as string | undefined;
      const jwtToken = req.headers['x-blumira-jwt-token'] as string | undefined;

      if (clientId && clientSecret) {
        try {
          const token = await exchangeOAuthToken(clientId, clientSecret);
          scopedCreds = { jwtToken: token };
        } catch (err) {
          logger.error('OAuth token exchange failed', { error: (err as Error).message });
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'OAuth token exchange failed', detail: (err as Error).message }));
          return;
        }
      } else if (jwtToken) {
        scopedCreds = { jwtToken };
      }
      // No headers → fall through; tools/list & initialize stay unauthenticated.
    }

    // Pre-read the POST body so we can (a) gate credential-requiring methods and
    // (b) hand the parsed message straight to the stateless transport.
    let parsedBody: unknown;
    if (req.method === 'POST') {
      const raw = await readBody(req);
      try {
        parsedBody = raw ? JSON.parse(raw) : undefined;
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32700, message: 'Parse error' },
          id: null,
        }));
        return;
      }

      // Allow initialize and tools/list without credentials (unauthenticated
      // discovery); every other method requires credentials in gateway mode.
      const method = !Array.isArray(parsedBody)
        ? (parsedBody as { method?: string })?.method
        : undefined;
      const isUnauthMethod = method === 'tools/list' || method === 'initialize';
      if (isGatewayMode && !isUnauthMethod && !scopedCreds && !getCredentials()) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Missing credentials',
          detail: 'Provide X-Blumira-Client-ID + X-Blumira-Client-Secret or X-Blumira-JWT-Token headers',
        }));
        return;
      }
    }

    // SECURITY-CRITICAL: this transport MUST stay stateless (sessionIdGenerator:
    // undefined + enableJsonResponse: true) and be created fresh per request.
    // Per-request tenant credentials are carried in the AsyncLocalStorage context
    // opened by runWithCredentials() below, and a stateless request->single-response
    // flow keeps the whole tool call inside that context. A stateful/SSE transport
    // (sessionIdGenerator set, persistent stream shared across requests) would let a
    // long-lived connection serve later messages under a stale/foreign credential
    // context — re-review tenant isolation before changing this.
    const handle = async () => {
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    };

    // Gateway mode injects per-request tenant credentials via headers; scope them
    // to this request with AsyncLocalStorage so concurrent tenants never share a
    // credential slot. When absent (stdio/env mode, or an unauthenticated
    // tools/list / initialize probe) fall through to process.env.
    if (scopedCreds) {
      await runWithCredentials(scopedCreds, handle);
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
