import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.API_ORIGIN ?? `http://localhost:${process.env.PORT ?? 3000}`;

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    // The API server handles /api and the OAuth endpoints; the browser only ever talks to Vite.
    proxy: {
      '/api': api,
      '/auth': api,
    },
  },
});
