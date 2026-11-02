export const DEFAULT_SCOPES = [
  'user.read',
  'search.read',
  'playlists.read',
  'playlists.write',
  'collection.read',
  'collection.write',
];

export interface AppConfig {
  port: number;
  tidal: {
    clientId: string;
    clientSecret?: string;
    redirectUri: string;
    scopes: string[];
    authorizeUrl: string;
    tokenUrl: string;
    apiBaseUrl: string;
  };
  appBaseUrl: string;
  maxUploadBytes: number;
  sessionTtlMs: number;
  secureCookies: boolean;
  youtubeApiKey?: string;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const clientId = env.TIDAL_CLIENT_ID?.trim();
  if (!clientId) {
    throw new Error(
      'TIDAL_CLIENT_ID is not set. Create an app at https://developer.tidal.com/dashboard and copy .env.example to .env.',
    );
  }
  const redirectUri = env.TIDAL_REDIRECT_URI?.trim() || 'http://localhost:5173/auth/callback';
  const appBaseUrl = (env.APP_BASE_URL?.trim() || new URL(redirectUri).origin).replace(/\/$/, '');
  return {
    port: intEnv('PORT', 3000),
    tidal: {
      clientId,
      clientSecret: env.TIDAL_CLIENT_SECRET?.trim() || undefined,
      redirectUri,
      scopes: env.TIDAL_SCOPES?.trim() ? env.TIDAL_SCOPES.trim().split(/\s+/) : DEFAULT_SCOPES,
      authorizeUrl: 'https://login.tidal.com/authorize',
      tokenUrl: 'https://auth.tidal.com/v1/oauth2/token',
      apiBaseUrl: 'https://openapi.tidal.com/v2',
    },
    appBaseUrl,
    maxUploadBytes: intEnv('MAX_UPLOAD_MB', 200) * 1024 * 1024,
    sessionTtlMs: intEnv('SESSION_TTL_MINUTES', 240) * 60 * 1000,
    secureCookies: appBaseUrl.startsWith('https://'),
    youtubeApiKey: env.YOUTUBE_API_KEY?.trim() || undefined,
  };
}
