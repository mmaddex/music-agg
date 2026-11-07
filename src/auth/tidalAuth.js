// TIDAL OAuth 2.1 authorization-code + PKCE flow.
// Source: https://developer.tidal.com/documentation/api-sdk/api-sdk-authorization
//   authorize: GET  https://login.tidal.com/authorize
//              ?response_type=code&client_id&redirect_uri&scope&code_challenge_method=S256&code_challenge&state
//   token:     POST https://auth.tidal.com/v1/oauth2/token (form-encoded)
//              grant_type=authorization_code&client_id&code&redirect_uri&code_verifier
//              grant_type=refresh_token&refresh_token
// PKCE is enforced for all clients, so no client secret is sent in the user flow.

import crypto from 'node:crypto';

export const AUTHORIZE_URL = 'https://login.tidal.com/authorize';
export const TOKEN_URL = 'https://auth.tidal.com/v1/oauth2/token';

// Scopes from the TIDAL API reference (Authorization_Code_PKCE security scheme):
//   user.read        GET /users/me (username, country for catalogue lookups)
//   search.read      GET /searchResults
//   playlists.write  POST /playlists, POST /playlists/{id}/relationships/items
//   collection.write POST /userCollectionTracks/me/relationships/items,
//                    POST /userCollectionAlbums/me/relationships/items
export const SCOPES = ['user.read', 'search.read', 'playlists.write', 'collection.write'];

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** RFC 7636 S256: verifier = 43-char random string, challenge = base64url(sha256(verifier)). */
export function createPkcePair() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function createState() {
  return b64url(crypto.randomBytes(16));
}

export function buildAuthorizeUrl({ clientId, redirectUri, challenge, state, scopes = SCOPES }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes.join(' '),
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
  });
  return `${AUTHORIZE_URL}?${params}`;
}

export class TidalAuthError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function tokenRequest(form, fetchImpl) {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const reason = body.error_description || body.error || body.userMessage || `HTTP ${res.status}`;
    throw new TidalAuthError(`TIDAL token request failed: ${reason}`, { status: res.status, body });
  }
  return toTokenSet(body);
}

function toTokenSet(body, previous = {}) {
  return {
    accessToken: body.access_token,
    // Refresh responses may omit refresh_token; keep the one we already have.
    refreshToken: body.refresh_token || previous.refreshToken || null,
    scope: body.scope || previous.scope || null,
    // Refresh a minute early to avoid racing expiry mid-request.
    expiresAt: Date.now() + Math.max(0, (Number(body.expires_in) || 3600) - 60) * 1000,
  };
}

export function exchangeCode({ clientId, code, redirectUri, verifier, fetchImpl = fetch }) {
  return tokenRequest(
    { grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: redirectUri, code_verifier: verifier },
    fetchImpl,
  );
}

export async function refreshTokens({ clientId, tokens, fetchImpl = fetch }) {
  if (!tokens?.refreshToken) throw new TidalAuthError('No refresh token; please log in again.', { status: 401 });
  const next = await tokenRequest(
    { grant_type: 'refresh_token', refresh_token: tokens.refreshToken, client_id: clientId },
    fetchImpl,
  );
  return { ...next, refreshToken: next.refreshToken || tokens.refreshToken };
}
