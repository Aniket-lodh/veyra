import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';
import { sseProxyPlugin } from './vite/sse-proxy';

// Override with VITE_API_PROXY_TARGET when the API is not on :8080.
const API_PROXY_TARGET =
  process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:8080';

const rawPort = process.env.PORT ?? '5173';
const FRONTEND_PORT = Number(rawPort);
if (!Number.isInteger(FRONTEND_PORT) || FRONTEND_PORT < 1 || FRONTEND_PORT > 65535) {
  throw new Error(`[vite.config] Invalid frontend PORT "${rawPort}": must be an integer between 1 and 65535`);
}

// API prefixes that overlap SPA routes (/jobs, …). Bypass proxies
// text/html navigations so refresh still serves the app shell.
// /events is handled by sseProxyPlugin (must stream; default proxy buffers).
const API_PATHS = [
  '/jobs',
  '/queue',
  '/workers',
  '/health',
  '/api-keys',
  '/auth',
];

function shouldBypassProxy(accept: string | undefined): string | null {
  if (accept && accept.includes('text/html')) {
    return '/index.html';
  }
  return null;
}

export default defineConfig({
  plugins: [react(), tailwindcss(), sseProxyPlugin(API_PROXY_TARGET)],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: FRONTEND_PORT,
    strictPort: true,
    proxy: Object.fromEntries(
      API_PATHS.map((p) => [
        p,
        {
          target: API_PROXY_TARGET,
          changeOrigin: true,
          bypass: (req: { headers: { accept?: string } }) =>
            shouldBypassProxy(req.headers.accept),
        },
      ]),
    ),
  },
  preview: {
    port: FRONTEND_PORT,
    strictPort: true,
  },
  build: {
    sourcemap: true,
  },
});
