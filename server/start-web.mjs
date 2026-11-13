import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkbenchService } from './local-workbench.mjs';

const host = '127.0.0.1';
const ports = Array.from({ length: 11 }, (_, i) => 5173 + i);
const dist = realpathSync(fileURLToPath(new URL('../dist/', import.meta.url)));
const instance = createHash('sha256').update(dist).digest('hex');
const apiPrefix = '/api/workbench';
const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.wasm', 'application/wasm'],
]);
const contentPolicy = "default-src 'none'; script-src 'self' 'unsafe-eval'; worker-src 'self' blob:; " +
  "style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; " +
  "object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

const origin = port => 'http://' + host + ':' + port;
function openWorkbench(port) {
  const url = origin(port) + '/';
  console.log('Render Workbench: ' + url);
  if (process.env.RENDER_WORKBENCH_NO_BROWSER === '1') return;
  const [command, args] = process.platform === 'win32'
    ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  const browser = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
  browser.on('error', () => console.log('Open the address above in Chrome or Edge.'));
  browser.unref();
}

async function existing(port) {
  try {
    const response = await fetch(origin(port) + '/_render_workbench', {
      signal: AbortSignal.timeout(450), redirect: 'error', method: 'HEAD',
    });
    return response.ok && response.headers.get('x-render-workbench-instance') === instance;
  } catch { return false; }
}

async function run() {
  if (!existsSync(path.join(dist, 'index.html'))) throw new Error('Web build is missing dist/index.html.');
  const running = (await Promise.all(ports.map(existing))).findIndex(Boolean);
  if (running >= 0) { openWorkbench(ports[running]); return; }

  let port;
  let service;
  const server = createServer((req, res) => {
    if (req.headers.host !== host + ':' + port) { res.writeHead(403).end(); return; }
    const url = new URL(req.url, origin(port));
    if (url.pathname.startsWith(apiPrefix + '/')) {
      req.url = url.pathname.slice(apiPrefix.length) + url.search;
      void service.handle(req, res);
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
    if (url.pathname === '/_render_workbench') {
      res.writeHead(200, { 'X-Render-Workbench-Instance': instance, 'Cache-Control': 'no-store' }).end();
      return;
    }
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (name !== 'index.html' && !/^assets\/[a-zA-Z0-9._-]+$/.test(name)) {
      res.writeHead(404).end(); return;
    }
    const type = types.get(path.extname(name));
    if (!type) { res.writeHead(404).end(); return; }
    const stream = createReadStream(path.join(dist, name));
    stream.once('error', () => {
      if (res.headersSent) res.destroy();
      else res.writeHead(404).end();
    });
    stream.once('open', () => {
      res.writeHead(200, {
        'Content-Type': type, 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': contentPolicy,
        'Cache-Control': name === 'index.html' ? 'no-cache' : 'public, max-age=86400',
      });
      if (req.method === 'HEAD') { stream.destroy(); res.end(); }
      else stream.pipe(res);
    });
    res.once('close', () => stream.destroy());
  });

  for (const candidate of ports) {
    const bound = await new Promise((resolve, reject) => {
      function onError(error) {
        if (error.code === 'EADDRINUSE') resolve(false);
        else reject(error);
      }
      server.once('error', onError);
      server.listen(candidate, host, () => {
        server.off('error', onError);
        resolve(true);
      });
    });
    if (bound) { port = candidate; break; }
    if (await existing(candidate)) { openWorkbench(candidate); return; }
  }
  if (!port) throw new Error('Ports 5173–5183 are busy. Close another local service and try again.');
  service = createWorkbenchService();
  server.once('close', () => service.close());
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      server.close();
      server.closeAllConnections();
    });
  }
  console.log('Keep this window open while using the workbench. Press Ctrl+C to stop.');
  openWorkbench(port);
}

run().catch(error => { console.error(error.message); process.exitCode = 1; });
