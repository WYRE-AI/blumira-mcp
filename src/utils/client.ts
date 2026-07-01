import { AsyncLocalStorage } from 'node:async_hooks';
import { BlumiraClient } from '@wyre-technology/node-blumira';
import { logger } from './logger.js';

// --- OAuth2 token cache ---
interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

// Keyed by `${clientId}:${clientSecret}`, so it never mixes tenants. Safe to
// keep at module scope: it only ever returns the token for the exact credential
// pair that was exchanged, never a foreign tenant's token.
const tokenCache = new Map<string, CachedToken>();

/**
 * Exchange client_id + client_secret for a JWT via Blumira's OAuth endpoint.
 * Caches the token until 60 seconds before expiry.
 */
export async function exchangeOAuthToken(
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const cacheKey = `${clientId}:${clientSecret}`;
  const cached = tokenCache.get(cacheKey);

  if (cached && Date.now() < cached.expiresAt) {
    return cached.accessToken;
  }

  logger.info('Exchanging OAuth2 client credentials for JWT');

  const res = await fetch('https://auth.blumira.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      audience: 'https://api.blumira.com/public-api/v1',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OAuth token exchange failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  const expiresIn = data.expires_in || 3600;

  // Cache with 60-second buffer before actual expiry
  tokenCache.set(cacheKey, {
    accessToken: data.access_token,
    expiresAt: Date.now() + (expiresIn - 60) * 1000,
  });

  logger.info('OAuth token exchange successful', { expiresIn });
  return data.access_token;
}

// ---- Request-scoped credential store ----
//
// SECURITY-CRITICAL: in gateway mode the HTTP layer runs each request inside
// runWithCredentials({...}); getCredentials()/getClient() read from that context.
// Credentials must NEVER be stashed in module-level mutable state (process.env or
// a cached client singleton): under concurrent multi-tenant requests the event
// loop interleaves across await points, so a shared slot lets one tenant's token
// be read by another tenant's tool call. The AsyncLocalStorage context is the
// only per-request credential carrier. Falls back to process.env for stdio /
// single-tenant mode.

export interface Credentials {
  jwtToken?: string;
  clientId?: string;
  clientSecret?: string;
}

const credStore = new AsyncLocalStorage<Credentials>();

export function runWithCredentials<T>(creds: Credentials, fn: () => T): T {
  return credStore.run(creds, fn);
}

// Sentinel returned by getCredentials() when OAuth client credentials are present
// but the JWT has not been exchanged yet. Lets health/status report "configured"
// without performing the async exchange. getClient() never treats it as a token.
const OAUTH_PENDING = '__oauth_pending__';

/**
 * Resolve credentials for health/status signaling.
 *
 * Priority: request-scoped store (gateway mode) → process.env (stdio mode).
 * Returns `{ jwtToken }` where jwtToken is either a real token or the
 * OAUTH_PENDING sentinel (client credentials present, not yet exchanged), or
 * null when no credentials are configured.
 */
export function getCredentials(): { jwtToken: string } | null {
  const scoped = credStore.getStore();
  if (scoped) {
    if (scoped.jwtToken) return { jwtToken: scoped.jwtToken };
    if (scoped.clientId && scoped.clientSecret) return { jwtToken: OAUTH_PENDING };
  }

  const jwtToken = process.env.BLUMIRA_JWT_TOKEN;
  if (jwtToken) {
    return { jwtToken };
  }

  const clientId = process.env.BLUMIRA_CLIENT_ID;
  const clientSecret = process.env.BLUMIRA_CLIENT_SECRET;
  if (clientId && clientSecret) {
    // Signal "credentials available"; the real token is fetched in getClient().
    return { jwtToken: OAUTH_PENDING };
  }

  logger.warn('Missing credentials', { hasJwtToken: false, hasClientId: !!clientId });
  return null;
}

/**
 * Build a Blumira API client from the effective credential source.
 *
 * A fresh client is constructed on every call (construction is cheap — config
 * only, no connection) so concurrent tenants never share a client instance.
 * Request-scoped credentials win; otherwise fall back to process.env for
 * stdio / single-tenant mode. The two sources are never mixed.
 */
export async function getClient(): Promise<BlumiraClient> {
  const scoped = credStore.getStore();
  const source: Credentials =
    scoped && (scoped.jwtToken || (scoped.clientId && scoped.clientSecret))
      ? scoped
      : {
          jwtToken: process.env.BLUMIRA_JWT_TOKEN,
          clientId: process.env.BLUMIRA_CLIENT_ID,
          clientSecret: process.env.BLUMIRA_CLIENT_SECRET,
        };

  // Direct JWT path
  if (source.jwtToken && source.jwtToken !== OAUTH_PENDING) {
    logger.info('Created Blumira API client (JWT)');
    return new BlumiraClient({ jwtToken: source.jwtToken });
  }

  // OAuth client credentials path
  if (source.clientId && source.clientSecret) {
    const token = await exchangeOAuthToken(source.clientId, source.clientSecret);
    logger.info('Created Blumira API client (OAuth)');
    return new BlumiraClient({ jwtToken: token });
  }

  throw new Error(
    'No Blumira credentials configured. Set BLUMIRA_JWT_TOKEN or BLUMIRA_CLIENT_ID + BLUMIRA_CLIENT_SECRET.',
  );
}
