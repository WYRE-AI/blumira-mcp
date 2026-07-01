import { createServer as createHttpServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import { getCredentials, runWithCredentials, exchangeOAuthToken } from './utils/client.js';
import type { Credentials } from './utils/client.js';
import { logger } from './utils/logger.js';

function startHttpServer(): void {
  const port = parseInt(process.env.MCP_HTTP_PORT || '8080', 10);
  const host = process.env.MCP_HTTP_HOST || '0.0.0.0';
  const isGatewayMode = process.env.AUTH_MODE === 'gateway';

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    // Shallow, unauthenticated liveness probe. Always 200 while the process is
    // up — in gateway mode credentials arrive per-request via headers, so a
    // credential-gated status would wrongly fail the Azure liveness probe.
    if (url.pathname === '/health' || url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        transport: 'http',
        credentials: { configured: !!getCredentials() },
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
        // No credentials provided — allow tools/list and initialize (unauthenticated discovery);
        // individual tool calls will fail when they invoke getClient().
        await handle();
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
