import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { pipeSSE } from './sse-proxy.ts';

/**
 * Regression: chunks must reach the client before the upstream ends.
 * The previous Vite http-proxy path buffered until close.
 */
describe('pipeSSE', () => {
  let upstream: http.Server;
  let upstreamPort = 0;
  let proxy: http.Server;
  let proxyPort = 0;

  before(async () => {
    upstream = http.createServer((req, res) => {
      if (!req.url?.startsWith('/events')) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      res.write('id: 1\nevent: resync\ndata: {"v":1,"revision":1,"resources":["jobs"]}\n\n');
      // Keep the upstream open so end-of-stream buffering would hang the client.
      setTimeout(() => {
        if (!res.writableEnded) res.end();
      }, 500);
    });
    await new Promise<void>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const uAddr = upstream.address();
    if (!uAddr || typeof uAddr === 'string') throw new Error('no upstream port');
    upstreamPort = uAddr.port;

    proxy = http.createServer((req, res) => {
      pipeSSE(`http://127.0.0.1:${upstreamPort}`, req, res);
    });
    await new Promise<void>((resolve) => {
      proxy.listen(0, '127.0.0.1', () => resolve());
    });
    const pAddr = proxy.address();
    if (!pAddr || typeof pAddr === 'string') throw new Error('no proxy port');
    proxyPort = pAddr.port;
  });

  after(async () => {
    await Promise.all([
      new Promise<void>((resolve, reject) =>
        proxy.close((err) => (err ? reject(err) : resolve())),
      ),
      new Promise<void>((resolve, reject) =>
        upstream.close((err) => (err ? reject(err) : resolve())),
      ),
    ]);
  });

  it('forwards SSE chunks before upstream ends', async () => {
    const got = await new Promise<string>((resolve, reject) => {
      const req = http.get(
        `http://127.0.0.1:${proxyPort}/events`,
        (res) => {
          assert.equal(res.statusCode, 200);
          assert.match(
            String(res.headers['content-type'] ?? ''),
            /text\/event-stream/,
          );
          assert.equal(res.headers['x-accel-buffering'], 'no');
          assert.equal(res.headers['content-length'], undefined);

          let body = '';
          const deadline = setTimeout(() => {
            req.destroy();
            reject(new Error('timed out waiting for streamed chunk'));
          }, 300);

          res.on('data', (chunk: Buffer) => {
            body += chunk.toString('utf8');
            if (body.includes('event: resync')) {
              clearTimeout(deadline);
              req.destroy();
              resolve(body);
            }
          });
          res.on('error', reject);
        },
      );
      req.on('error', (err) => {
        // destroy() after success triggers an abort; ignore if we already resolved.
        if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') return;
        reject(err);
      });
    });

    assert.match(got, /event: resync/);
    assert.match(got, /retry: 3000/);
  });
});
