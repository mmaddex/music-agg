import { createHash, randomBytes } from 'node:crypto';

/**
 * TIDAL OAuth 2.1 — authorization code flow with PKCE (mandatory for all clients).
 * Docs: https://developer.tidal.com/documentation/api-sdk/api-sdk-authorization
 *   authorize: https://login.tidal.com/authorize
 *   token:     https://auth.tidal.com/v1/oauth2/token
 */

export interface TidalOAuthConfig {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes: string[];
  authorizeUrl: string;
  tokenUrl: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** epoch ms */
  expiresAt: number;
  scope?: string;
  /** TIDAL returns the user id alongside the token; may be absent. */
  userId?: string;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

const b64url = (buf: Buffer) => buf.toString('base64url');

export function createPkcePair(): PkcePair {
  // RFC 7636: 43-128 chars from the unreserved set; 32 random bytes -> 43 base64url chars.
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function createState(): string {
  return b64url(randomBytes(24));
}

export function buildAuthorizeUrl(cfg: TidalOAuthConfig, challenge: string, state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: cfg.scopes.join(' '),
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
  });
  return `${cfg.authorizeUrl}?${params}`;
}

export class TidalAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  user_id?: number | string;
  user?: { userId?: number | string };
}

async function tokenRequest(
  cfg: TidalOAuthConfig,
  body: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<TokenSet> {
  const res = await fetchImpl(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      ...(cfg.clientSecret ? { client_secret: cfg.clientSecret } : {}),
      ...body,
    }).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { error_description?: string; error?: string };
      detail = j.error_description || j.error || detail;
    } catch {
      // not JSON
    }
    throw new TidalAuthError(`TIDAL token request failed (${res.status}): ${detail}`, res.status);
  }
  const json = JSON.parse(text) as TokenResponse;
  const userId = json.user_id ?? json.user?.userId;
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    scope: json.scope,
    userId: userId !== undefined ? String(userId) : undefined,
  };
}

export function exchangeCode(
  cfg: TidalOAuthConfig,
  code: string,
  verifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenSet> {
  return tokenRequest(
    cfg,
    { grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri, code_verifier: verifier },
    fetchImpl,
  );
}

export async function refreshTokens(
  cfg: TidalOAuthConfig,
  current: TokenSet,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenSet> {
  if (!current.refreshToken) throw new TidalAuthError('Session expired — please log in to TIDAL again.', 401);
  const next = await tokenRequest(
    cfg,
    { grant_type: 'refresh_token', refresh_token: current.refreshToken },
    fetchImpl,
  );
  // TIDAL does not always rotate the refresh token.
  return { ...next, refreshToken: next.refreshToken ?? current.refreshToken, userId: next.userId ?? current.userId };
}

/**
 * Hands out a valid access token, refreshing shortly before expiry. Concurrent
 * callers share one in-flight refresh.
 */
export class TokenManager {
  private refreshing?: Promise<TokenSet>;

  constructor(
    private readonly cfg: TidalOAuthConfig,
    private tokens: TokenSet,
    private readonly onUpdate?: (t: TokenSet) => void,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get current(): TokenSet {
    return this.tokens;
  }

  async getAccessToken(): Promise<string> {
    if (Date.now() < this.tokens.expiresAt - 60_000) return this.tokens.accessToken;
    return (await this.forceRefresh()).accessToken;
  }

  forceRefresh(): Promise<TokenSet> {
    this.refreshing ??= refreshTokens(this.cfg, this.tokens, this.fetchImpl)
      .then((t) => {
        this.tokens = t;
        this.onUpdate?.(t);
        return t;
      })
      .finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }
}
