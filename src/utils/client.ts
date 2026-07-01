import { AsyncLocalStorage } from 'node:async_hooks';
import { BlumiraClient } from '@wyre-technology/node-blumira';
import { logger } from './logger.js';

// --- OAuth2 token cache ---
interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

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

// ---- Request-scoped credentials via AsyncLocalStorage ----

export interface Credentials {
  clientId: string;
  clientSecret: string;
  jwtToken: string;
}

// Request-scoped credential store. In gateway mode the HTTP layer runs each
// request inside runWithCredentials({clientId, clientSecret, jwtToken}).
// getCredentials() reads the ALS store first, falls back to process.env for
// stdio/single-tenant mode.
const credStore = new AsyncLocalStorage<Credentials>();

export function runWithCredentials<T>(creds: Credentials, fn: () => T): T {
  return credStore.run(creds, fn);
}

/**
 * Resolve credentials in priority order:
 * 1. ALS store (set per-request in gateway mode via runWithCredentials)
 * 2. process.env fallback (stdio / single-tenant mode)
 */
export function getCredentials(): Credentials | null {
  const scoped = credStore.getStore();
  if (scoped && (scoped.jwtToken || (scoped.clientId && scoped.clientSecret))) {
    return scoped;
  }

  const jwtToken = process.env.BLUMIRA_JWT_TOKEN || '';
  const clientId = process.env.BLUMIRA_CLIENT_ID || '';
  const clientSecret = process.env.BLUMIRA_CLIENT_SECRET || '';

  if (jwtToken || (clientId && clientSecret)) {
    return { jwtToken, clientId, clientSecret };
  }

  logger.warn('Missing credentials', { hasJwtToken: false, hasClientId: !!clientId });
  return null;
}

/**
 * Build a BlumiraClient from the current request-scoped (or env) credentials.
 * No singleton — built per-call. The OAuth token cache provides performance
 * caching without sharing mutable credential state across requests.
 */
export async function getClient(): Promise<BlumiraClient> {
  const creds = getCredentials();
  if (!creds) {
    throw new Error(
      'No Blumira credentials configured. Set BLUMIRA_JWT_TOKEN or BLUMIRA_CLIENT_ID + BLUMIRA_CLIENT_SECRET.',
    );
  }

  // JWT takes priority
  if (creds.jwtToken) {
    logger.info('Created Blumira API client (JWT)');
    return new BlumiraClient({ jwtToken: creds.jwtToken });
  }

  // OAuth client credentials
  if (creds.clientId && creds.clientSecret) {
    const token = await exchangeOAuthToken(creds.clientId, creds.clientSecret);
    logger.info('Created Blumira API client (OAuth)');
    return new BlumiraClient({ jwtToken: token });
  }

  throw new Error(
    'No Blumira credentials configured. Set BLUMIRA_JWT_TOKEN or BLUMIRA_CLIENT_ID + BLUMIRA_CLIENT_SECRET.',
  );
}
