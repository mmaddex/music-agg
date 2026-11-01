// Runtime configuration from environment variables. See .env.example.

const env = process.env;
const port = Number(env.PORT) || 3000;

// Render sets RENDER_EXTERNAL_URL automatically (e.g. https://music-agg.onrender.com).
const baseUrl = (env.PUBLIC_BASE_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/+$/, '');

const workflowConfigured = Boolean(env.RENDER_API_KEY && env.WORKFLOW_SLUG);

export const config = {
  port,
  isProduction: env.NODE_ENV === 'production',
  baseUrl,
  databaseUrl: env.DATABASE_URL || '',
  tidal: {
    clientId: env.TIDAL_CLIENT_ID || '',
    // Must exactly match a redirect URI registered for the app at developer.tidal.com.
    redirectUri: env.TIDAL_REDIRECT_URI || `${baseUrl}/auth/callback`,
  },
  // Minimum spacing between TIDAL API requests (per task run). Raise if you see 429s.
  tidalMinIntervalMs: Number(env.TIDAL_MIN_INTERVAL_MS ?? 200),
  sessionSecret: env.SESSION_SECRET || '',
  tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY || '',
  maxUploadBytes: (Number(env.MAX_UPLOAD_MB) || 100) * 1024 * 1024,
  workflows: {
    // "render" in production; "inline" runs tasks in the web process (local dev only).
    mode: env.WORKFLOW_MODE || (workflowConfigured ? 'render' : 'inline'),
    slug: env.WORKFLOW_SLUG || '',
  },
  retentionDays: Number(env.IMPORT_RETENTION_DAYS) || 30,
};

export function configProblems() {
  const problems = [];
  if (!config.tidal.clientId) problems.push('TIDAL_CLIENT_ID is not set.');
  if (!config.databaseUrl) problems.push('DATABASE_URL is not set.');
  if (!config.tokenEncryptionKey) problems.push('TOKEN_ENCRYPTION_KEY is not set.');
  if (config.isProduction && !config.sessionSecret) problems.push('SESSION_SECRET is not set.');
  if (config.workflows.mode === 'render' && !(env.RENDER_API_KEY && config.workflows.slug)) {
    problems.push('WORKFLOW_MODE=render needs RENDER_API_KEY and WORKFLOW_SLUG.');
  }
  if (config.isProduction && config.workflows.mode === 'inline') {
    problems.push('Running workflows inline in production (no durability). Set RENDER_API_KEY and WORKFLOW_SLUG.');
  }
  return problems;
}
