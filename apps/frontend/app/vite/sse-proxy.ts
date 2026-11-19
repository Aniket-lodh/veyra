import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, Plugin } from 'vite';

/**
 * Forward /events as an unbuffered chunked stream.
 * Vite's default http-proxy can hold SSE until upstream closes; that leaves
 * the console on the safety refetch and looks like the old poll loop.
 */
export function pipeSSE(
  target: string,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const upstream = new URL(target);
  const transport = upstream.protocol === 'https:' ? https : http;
  const headers: http.OutgoingHttpHeaders = {
    ...req.headers,
    host: upstream.host,
  };
  delete headers['accept-encoding'];
  headers.accept = 'text/event-stream';
  headers['cache-control'] = 'no-cache';
  headers.connection = 'keep-alive';

  const proxyReq = transport.request(
    {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
      path: req.url?.startsWith('/events') ? req.url : '/events',
      method: 'GET',
      headers,
    },
    (proxyRes) => {
      const outHeaders: http.OutgoingHttpHeaders = { ...proxyRes.headers };
      delete outHeaders['content-length'];
      delete outHeaders['content-encoding'];
      outHeaders['cache-control'] = 'no-cache, no-transform';
      outHeaders['x-accel-buffering'] = 'no';
      outHeaders.connection = 'keep-alive';
      res.writeHead(proxyRes.statusCode ?? 502, outHeaders);

      proxyRes.on('data', (chunk: Buffer) => {
        if (!res.writableEnded) {
          res.write(chunk);
          const flushable = res as ServerResponse & { flush?: () => void };
          flushable.flush?.();
        }
      });
      proxyRes.on('end', () => {
        if (!res.writableEnded) res.end();
      });
      proxyRes.on('error', () => {
        if (!res.writableEnded) res.end();
      });
    },
  );

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader('content-type', 'text/plain');
    }
    if (!res.writableEnded) {
      res.end(`sse proxy error: ${err.message}`);
    }
  });

  const abort = () => {
    proxyReq.destroy();
  };
  req.on('aborted', abort);
  res.on('close', abort);

  proxyReq.end();
}

/** Vite plugin: stream same-origin /events before SPA middleware. */
export function sseProxyPlugin(target: string): Plugin {
  return {
    name: 'veyra-sse-proxy',
    configureServer(server) {
      const handler: Connect.NextHandleFunction = (req, res, next) => {
        if (!req.url || !req.url.startsWith('/events')) {
          next();
          return;
        }
        pipeSSE(target, req, res);
      };
      server.middlewares.use(handler);
    },
  };
}
