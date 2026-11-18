import { app, BrowserWindow, dialog, Menu, session } from 'electron';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createWorkbenchService } from '../server/local-workbench.mjs';

let window;
let server;
let service;

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
};
// The bundled rhino3dm bindings generate JavaScript invokers in their workers.
// Three.js creates a blob worker that inherits the page's script policy.
const contentPolicy = "default-src 'none'; script-src 'self' 'unsafe-eval'; worker-src 'self' blob:; " +
  "style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; " +
  "object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

async function start() {
  const secret = randomBytes(32).toString('hex');
  const dist = path.join(app.getAppPath(), 'dist');
  const state = session.fromPartition('render-workbench');
  let origin;
  service = createWorkbenchService({
    authorize: req => req.headers['x-render-desktop'] === secret,
    selectModelFiles: async () => {
      const result=await dialog.showOpenDialog(window,{
        title:'导入模型及材质文件',properties:['openFile','multiSelections'],
        filters:[{name:'模型及资源',extensions:['obj','3dm','mtl','png','jpg','jpeg','webp','gif']}],
      });
      return result.canceled?[]:result.filePaths;
    },
    selectFolder: async startPath => {
      const result = await dialog.showOpenDialog(window, {
        title: '选择文件夹',
        defaultPath: startPath || app.getPath('documents'),
        properties: ['openDirectory', 'createDirectory'],
      });
      return result.filePaths[0] || '';
    },
    selectExport: async name => {
      const result = await dialog.showSaveDialog(window, {
        title: '保存 PNG',
        defaultPath: path.join(app.getPath('pictures'), name),
        filters: [{ name: 'PNG 图片', extensions: ['png'] }],
      });
      return result.filePath || '';
    },
  });

  server = createServer((req, res) => {
    if (req.headers.host !== origin.slice('http://'.length) || req.headers['x-render-desktop'] !== secret ||
        (req.headers.origin && req.headers.origin !== origin)) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url, origin);
    if (url.pathname.startsWith('/api/workbench/')) {
      req.url = url.pathname.slice('/api/workbench'.length) + url.search;
      void service.handle(req, res);
      return;
    }
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!['GET', 'HEAD'].includes(req.method) ||
        (name !== 'index.html' && !/^assets\/[a-zA-Z0-9._-]+$/.test(name))) {
      res.writeHead(404).end();
      return;
    }
    const contentType = types[path.extname(name)];
    if (!contentType) { res.writeHead(404).end(); return; }
    const stream = createReadStream(path.join(dist, name));
    stream.once('error', () => {
      if (res.headersSent) res.destroy();
      else res.writeHead(404).end();
    });
    stream.once('open', () => {
      res.writeHead(200, {
        'Content-Type': contentType,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': contentPolicy,
      });
      if (req.method === 'HEAD') { stream.destroy(); res.end(); }
      else stream.pipe(res);
    });
    res.once('close', () => stream.destroy());
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = 'http://127.0.0.1:' + server.address().port;

  state.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  state.setPermissionCheckHandler(() => false);
  state.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith(origin + '/') && !/^(data:|blob:)/.test(details.url) });
  });
  state.webRequest.onBeforeSendHeaders({ urls: [origin + '/*'] }, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, 'X-Render-Desktop': secret } });
  });
  window = new BrowserWindow({
    title: '模型出图工作台', width: 1440, height: 920, minWidth: 740, minHeight: 560,
    show: false, backgroundColor: '#edf0f4',
    webPreferences: { session: state, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  await window.loadURL(origin);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.setAppUserModelId('com.renderworkbench.desktop');
  Menu.setApplicationMenu(null);
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.whenReady().then(start).catch(error => {
    dialog.showErrorBox('模型出图工作台无法启动', error.message);
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    service?.close();
    server?.closeAllConnections();
    server?.close();
  });
}
