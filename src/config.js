// Runtime configuration from environment variables. See .env.example.

const port = Number(process.env.PORT) || 3000;

// Render sets RENDER_EXTERNAL_URL automatically (e.g. https://music-agg.onrender.com).
const baseUrl = (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/+$/, '');

export const config = {
  port,
  isProduction: process.env.NODE_ENV === 'production',
  baseUrl,
  tidal: {
    clientId: process.env.TIDAL_CLIENT_ID || '',
    // Must exactly match a redirect URI registered for the app at developer.tidal.com.
    redirectUri: process.env.TIDAL_REDIRECT_URI || `${baseUrl}/auth/callback`,
  },
  // Minimum spacing between TIDAL API requests (per user session). Raise if you see 429s.
  tidalMinIntervalMs: Number(process.env.TIDAL_MIN_INTERVAL_MS ?? 200),
  sessionSecret: process.env.SESSION_SECRET || '',
  maxUploadBytes: (Number(process.env.MAX_UPLOAD_MB) || 100) * 1024 * 1024,
};

export function configProblems() {
  const problems = [];
  if (!config.tidal.clientId) problems.push('TIDAL_CLIENT_ID is not set.');
  if (config.isProduction && !config.sessionSecret) problems.push('SESSION_SECRET is not set.');
  return problems;
}
