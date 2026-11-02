import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { createApp } from './app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`\n${(err as Error).message}\n`);
  process.exit(1);
}

// In production the built web client lives in dist/web (see vite.config.ts).
const staticDir = path.resolve(here, '../web');
const { app } = createApp({ config, staticDir });

app.listen(config.port, () => {
  console.log(`music-agg API listening on http://localhost:${config.port}`);
  console.log(`TIDAL redirect URI: ${config.tidal.redirectUri}`);
  console.log(`Open ${config.appBaseUrl} to start.`);
});
