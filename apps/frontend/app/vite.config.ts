import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

// In dev, the frontend talks to the Go api via a Vite proxy so the same
// relative URLs (`/jobs`, `/queue/stats`, …) used by the app work both
// here and in prod (where nginx fronts everything on a single origin).
//
// Override the upstream with VITE_API_PROXY_TARGET when running the api on
// a different host or port (e.g. another machine on the LAN).
const API_PROXY_TARGET =
  process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:8080';

// Paths the api owns. /internal/* is intentionally NOT proxied — debug
// routes must stay reachable only when the dev explicitly hits the api
// directly, never through the frontend origin.
//
// Critical: these prefixes OVERLAP with frontend client routes (`/jobs`
// is a list page, `/jobs/:id` is a detail page, `/jobs/new` is the
// enqueue form). A naive proxy would steal those URLs from the SPA on
// direct navigation / page refresh and serve API JSON instead of the
// app shell. The bypass below distinguishes the two using the Accept
// header — page navigations send `text/html`, our fetch client sets
// `application/json` explicitly.
const API_PATHS = ['/jobs', '/queue', '/workers', '/health'];

// shouldBypassProxy returns the path to serve from Vite's dev server when
// the request is a browser page navigation rather than an API call. The
// `text/html` heuristic is robust because (a) modern browsers always send
// it on top-level navigations, and (b) our api client explicitly sets
// `Accept: application/json`, so legitimate API calls never get bypassed.
function shouldBypassProxy(accept: string | undefined): string | null {
  if (accept && accept.includes('text/html')) {
    return '/index.html';
  }
  return null;
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: Object.fromEntries(
      API_PATHS.map((p) => [
        p,
        {
          target: API_PROXY_TARGET,
          changeOrigin: true,
          bypass: (req) => shouldBypassProxy(req.headers.accept),
        },
      ]),
    ),
  },
  build: {
    sourcemap: true,
  },
});
