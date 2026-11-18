import * as fs from 'node:fs/promises';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { assistantConfig, assistantEndpoint, chatAssistant, testAssistant } from './assistant.mjs';
import { createModelImports } from './model-imports.mjs';

const TTL = 24 * 60 * 60 * 1000;
const LIMIT = 256 * 1024 * 1024;
const MESH_INPUT_LIMIT = 1024 * 1024 * 1024;
const MESH_OUTPUT_LIMIT = 512 * 1024 * 1024;
const CACHE_NAME = 'RenderWorkbench-MeshCache';
const CACHE_OWNER = '.render-workbench-cache';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = process.versions.electron && process.resourcesPath && existsSync(path.join(process.resourcesPath, 'rhino-mesh.py'))
  ? path.join(process.resourcesPath, 'rhino-mesh.py')
  : path.join(HERE, 'rhino-mesh.py');
const PICKER = path.join(HERE, 'pick-folder.ps1');
const keys = /^[0-9a-f]{64}\.3dm$/;
const jobs = /^job-[a-f0-9-]{36}$/;
const stateHome = path.resolve(process.env.RENDER_WORKBENCH_HOME ||
  path.join(process.env.LOCALAPPDATA || os.homedir(), 'RenderWorkbench'));
const config = path.join(stateHome, 'settings.json');
const defaults = { cacheLocation: stateHome, exportLocation: '', cacheLocations: [] };
const signature = Buffer.from([137,80,78,71,13,10,26,10]);

function failure(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

async function getSettings() {
  try {
    return { ...defaults, ...JSON.parse(await fs.readFile(config, 'utf8')) };
  } catch (error) {
    if (error.code === 'ENOENT') return { ...defaults };
    throw failure('本地设置文件无法读取。', 500);
  }
}

async function saveSettings(value) {
  await fs.mkdir(stateHome, { recursive: true });
  const temp = path.join(stateHome, 'settings-' + randomUUID() + '.tmp');
  await fs.writeFile(temp, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
  try { await fs.rename(temp,config); }
  finally { await fs.unlink(temp).catch(() => {}); }
}

async function checkFolder(value, createDefault = false) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value) ||
      /^[\\/]{2}/.test(value)) throw failure('请选择本机的绝对文件夹路径。');
  const folder = path.resolve(value.trim());
  if (createDefault) await fs.mkdir(folder, { recursive: true });
  try {
    if (!(await fs.stat(folder)).isDirectory()) throw Error();
    return await fs.realpath(folder);
  } catch { throw failure('文件夹不存在或不可访问：' + folder); }
}

async function cacheFolder(location, create) {
  const parent = await checkFolder(location, create && location === stateHome);
  const dir = path.join(parent,CACHE_NAME);
  if (create) {
    try {
      await fs.mkdir(dir);
      await fs.writeFile(path.join(dir,CACHE_OWNER),'RenderWorkbench mesh cache v1',{ flag:'wx' });
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  let stats;
  try { stats = await fs.lstat(dir); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stats.isDirectory() || stats.isSymbolicLink() || (await fs.realpath(dir)).toLowerCase() !== dir.toLowerCase()) {
    throw failure('缓存子目录不是普通文件夹。请换一个缓存位置。');
  }
  const marker = path.join(dir,CACHE_OWNER);
  if (!(await fs.lstat(marker).catch(() => null))?.isFile() ||
      await fs.readFile(marker,'utf8') !== 'RenderWorkbench mesh cache v1') {
    throw failure('缓存位置已有同名文件夹。请选择其他位置，避免覆盖现有文件。');
  }
  return dir;
}

async function discardJob(dir) {
  const stats = await fs.lstat(dir).catch(() => null);
  if (!stats?.isDirectory() || stats.isSymbolicLink() ||
      (await fs.realpath(dir)).toLowerCase() !== dir.toLowerCase()) return;
  for (const name of ['source.3dm','mesh.3dm','result.json','progress.json']) {
    const item = path.join(dir,name);
    if ((await fs.lstat(item).catch(() => null))?.isFile()) await fs.unlink(item).catch(() => {});
  }
  await fs.rmdir(dir).catch(() => {});
}

async function sweep(location, all = false) {
  let dir;
  try { dir = await cacheFolder(location,false); }
  catch (error) {
    if (location === stateHome && !existsSync(stateHome)) return { count:0, bytes:0, removed:0 };
    throw error;
  }
  const stats = { count:0, bytes:0, removed:0 };
  if (!dir) return stats;
  for (const file of await fs.readdir(dir,{withFileTypes:true})) {
    const absolute = path.join(dir,file.name);
    if (file.isDirectory() && jobs.test(file.name)) {
      if (Date.now() - (await fs.stat(absolute)).mtimeMs >= TTL) await discardJob(absolute);
      continue;
    }
    if (!file.isFile() || !keys.test(file.name)) continue;
    const entry = await fs.lstat(absolute).catch(() => null);
    if (!entry?.isFile()) continue;
    if (all || Date.now() - entry.mtimeMs >= TTL) {
      try { await fs.unlink(absolute); stats.removed++; continue; }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    }
    stats.count++; stats.bytes += entry.size;
  }
  return stats;
}

function rhinoExe() {
  if (process.platform !== 'win32' || process.env.RENDER_WORKBENCH_NO_RHINO === '1') return null;
  const candidates = [process.env.RENDER_RHINO_EXE,
    path.join(process.env.ProgramFiles || 'C:\\Program Files','Rhino 8','System','Rhino.exe'),
    'D:\\rhino8\\System\\Rhino.exe'];
  return candidates.find(p => p && path.isAbsolute(p) && existsSync(p)) ?? null;
}

async function body(req, limit) {
  const parts = [];
  let bytes = 0;
  if (Number(req.headers['content-length'] || 0) > limit) {
    req.resume();
    throw failure('文件超过本地处理上限。',413);
  }
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) {
      req.resume();
      throw failure('文件超过本地处理上限。',413);
    }
    parts.push(chunk);
  }
  return Buffer.concat(parts,bytes);
}

function child(exe, args, options) {
  return new Promise((resolve,reject) => {
    const { timeout, ...spawnOptions } = options;
    const p = spawn(exe,args,{ stdio:['ignore','pipe','pipe'],shell:false,...spawnOptions });
    const data = [];
    let length = 0, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill(); },timeout);
    p.stdout.on('data', b => { if (length < 8192) data.push(b); length += b.length; });
    p.stderr.resume();
    p.once('error',error => { clearTimeout(timer); reject(error); });
    p.once('close',code => {
      clearTimeout(timer);
      if (timedOut) reject(failure('本机处理超时，请检查 Rhino 授权或是否有阻塞的对话框。',504));
      else resolve({ code, stdout:Buffer.concat(data).toString('utf8').trim() });
    });
  });
}

async function saveMeshInput(req, sourcePath, hash) {
  let bytes = 0;
  let header = Buffer.alloc(0);
  const validate = new Transform({
    transform(chunk, _encoding, done) {
      bytes += chunk.length;
      if (bytes > MESH_INPUT_LIMIT) { done(failure('3DM 原文件超过 1 GiB。',413)); return; }
      if (header.length < 24) {
        header = Buffer.concat([header,chunk.subarray(0,24-header.length)]);
        if (header.length === 24 && header.toString('ascii') !== '3D Geometry File Format ') {
          done(failure('文件不是有效的 3DM。',422)); return;
        }
      }
      hash.update(chunk);
      done(null,chunk);
    },
    flush(done) { done(header.length < 24 ? failure('文件不是有效的 3DM。',422) : undefined); },
  });
  // Keep IncomingMessage out of pipeline so an invalid upload can receive a JSON error.
  const abort = () => validate.destroy(failure('3DM 上传已中断。',400));
  req.once('aborted',abort);
  try {
    const writing = pipeline(validate,createWriteStream(sourcePath,{flags:'wx'}));
    req.pipe(validate);
    await writing;
  } finally {
    req.off('aborted',abort);
    req.unpipe(validate);
    req.resume();
  }
}

async function convertMesh(req, location, exe, jobStarted) {
  const dir = await cacheFolder(location,true);
  const job = path.join(dir,'job-'+randomUUID());
  await fs.mkdir(job);
  try {
    const hash = createHash('sha256').update(await fs.readFile(WORKER));
    await saveMeshInput(req,path.join(job,'source.3dm'),hash);
    const output = path.join(dir,hash.digest('hex')+'.3dm');
    const entry = await fs.lstat(output).catch(() => null);
    if (entry?.isFile() && Date.now()-entry.mtimeMs < TTL) return { output, cached:true };
    if (entry) {
      if (!entry.isFile()) throw failure('缓存中存在同名的非普通文件。');
      await fs.unlink(output);
    }
    jobStarted(job);
    const scriptArg = /\s/.test(WORKER) ? '""'+WORKER+'""' : WORKER;
    await child(exe,['/new','/nosplash','/notemplate','/runscript="_-RunPythonScript '+scriptArg+' _-Exit _No"'],{
      timeout:240000, cwd:path.dirname(WORKER), windowsHide:true, windowsVerbatimArguments:true,
      env:{...process.env,RENDER_WORKBENCH_JOB:job},
    });
    const report = await fs.readFile(path.join(job,'result.json'),'utf8').then(JSON.parse).catch(() => null);
    if (!report) throw failure('Rhino 没有返回网格。请确认 Rhino 8 可正常打开且已授权。',422);
    if (report.error) {
      console.error('[model workbench] Rhino mesh:', report.error);
      throw failure('Rhino 网格处理失败：'+report.error.trim().split('\n').at(-1).slice(0,500),422);
    }
    if (!report.parts || !report.triangles) throw failure('Rhino 没有生成可用网格。',422);
    const file = path.join(job,'mesh.3dm');
    const fileStats = await fs.stat(file);
    if (!fileStats.isFile() || fileStats.size > MESH_OUTPUT_LIMIT) throw failure('可见网格转换结果超过 512 MiB。',413);
    await fs.rename(file,output);
    return { output, cached:false };
  } finally { await discardJob(job); }
}

function json(res,status,value) {
  res.writeHead(status,{ 'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store' });
  res.end(JSON.stringify(value));
}

function localRequest(req) {
  const host = req.headers.host || '';
  const origin = req.headers.origin;
  const loopback = ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  // Docker's host loopback publication reaches the container through its bridge.
  return (loopback || process.env.RENDER_WORKBENCH_DOCKER === '1') &&
    /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host) &&
    req.headers['x-render-workbench'] === 'local-v1' &&
    (!origin || origin === 'http://'+host) &&
    !['cross-site','same-site'].includes(req.headers['sec-fetch-site']);
}

function readAssistantConfig(input, previous) {
  try {
    const next = assistantConfig({ url: input?.url, model: input?.model, key: input?.key ?? '' });
    if (next.url && !next.key && input?.keepKey && previous?.url &&
        assistantEndpoint(next.url) === assistantEndpoint(previous.url)) next.key = previous.key;
    return next;
  } catch (error) { throw failure(error.message); }
}

async function jsonBody(req, limit) {
  const bytes = await body(req, limit);
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw failure('请求不是有效的 JSON。'); }
}

export function createWorkbenchService({ authorize = localRequest, selectFolder, selectExport, selectModelFiles } = {}) {
  let exclusive = false, picking = false;
  const nativeImport=!!selectModelFiles||(process.platform==='win32'&&process.env.RENDER_WORKBENCH_DOCKER!=='1');
  const modelImports=createModelImports(stateHome,async()=>{
    if(selectModelFiles)return selectModelFiles();
    const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const result=await child(powershell,['-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',path.join(HERE,'pick-models.ps1')],{timeout:120000,windowsHide:true});
    if(result.code!==0)throw failure('无法打开本机模型选择器。',422);
    try{return JSON.parse(result.stdout.replace(/^\uFEFF/,''));}catch{throw failure('无法读取本机文件选择结果。',422);}
  });
  let activeMesh;
  const meshQueue = [];
  function releaseExclusive() {
    const next = meshQueue.shift();
    if (next) next.start();
    else exclusive = false;
  }
  async function oneAtATime(fn) {
    if (exclusive) throw failure('本机正在处理模型或缓存，请稍后重试。',409);
    exclusive = true;
    try { return await fn(); } finally { releaseExclusive(); }
  }
  const prune = async () => {
      if (exclusive) return;
      await oneAtATime(async () => {
        const settings = await getSettings();
        for (const location of new Set([settings.cacheLocation,...settings.cacheLocations])) {
          await sweep(location).catch(() => {});
        }
      }).catch(console.error);
  };
  void prune();
  const interval = setInterval(prune,15*60*1000);
  interval.unref();
  async function handle(req,res) {
      if (!authorize(req)) { json(res,403,{error:'只接受本机工作台请求。'}); return; }
      const url = new URL(req.url,'http://localhost');
      const route = req.method+' '+url.pathname;
      try {
        const requestId = url.searchParams.get('id');
        if(route==='POST /models/pick'){
          if(!nativeImport)throw failure('当前运行环境使用浏览器文件选择器。',501);
          if(picking)throw failure('文件选择窗口已打开。',409);
          picking=true;
          try{json(res,200,await modelImports.pick());}finally{picking=false;}
          return;
        }
        if(route==='POST /models/reopen'){
          const input=await jsonBody(req,1024);
          json(res,200,await modelImports.reopen(input?.id));return;
        }
        if(route==='GET /models/file'){
          await modelImports.stream(url.searchParams.get('token'),res);return;
        }
        if (route === 'GET /mesh/progress') {
          const job = activeMesh?.id === requestId ? activeMesh.job : null;
          const state = job ? await fs.readFile(path.join(job,'progress.json'),'utf8').then(JSON.parse).catch(() => null) : null;
          const position = meshQueue.findIndex(item => item.id === requestId);
          json(res,200,state ?? (position >= 0 ? {stage:'queued', position:position+1} :
            activeMesh?.id === requestId ? {stage:job ? 'rhino' : 'receiving'} : {}));
          return;
        }
        const settings = await getSettings();
        if (route === 'GET /settings') {
          const stats = exclusive ? null : await oneAtATime(() => sweep(settings.cacheLocation)).catch(() => null);
          json(res,200,{cacheLocation:settings.cacheLocation, cacheFolder:path.join(settings.cacheLocation,CACHE_NAME),
            exportLocation:settings.exportLocation, cache:stats, hours:24, rhinoAvailable:!!rhinoExe(),
            nativeSave:!!selectExport, nativeImport, assistant:{
              url:settings.assistant?.url ?? '', model:settings.assistant?.model ?? '',
              hasKey:!!settings.assistant?.key,
            }});
        } else if (route === 'PUT /settings') {
          const input = await jsonBody(req, 12288);
          if (!input || typeof input !== 'object') throw failure('设置格式不正确。');
          const result = await oneAtATime(async () => {
            const current = await getSettings();
            const assistant = input.assistant === undefined ? current.assistant : readAssistantConfig(input.assistant, current.assistant);
            const cacheLocation = await checkFolder(input.cacheLocation || stateHome, !input.cacheLocation || input.cacheLocation===stateHome);
            await cacheFolder(cacheLocation,true);
            const exportLocation = input.exportLocation ? await checkFolder(input.exportLocation) : '';
            const cacheLocations = [...new Set([...current.cacheLocations,current.cacheLocation])].filter(x => x !== cacheLocation);
            await saveSettings({cacheLocation,exportLocation,cacheLocations,assistant});
            return {cacheLocation,exportLocation};
          });
          json(res,200,result);
        } else if (route === 'POST /assistant/test') {
          const config = readAssistantConfig(await jsonBody(req, 8192), settings.assistant);
          if (!config.url) throw failure('请填写 API URL 和模型名。');
          try { await testAssistant(config); }
          catch (error) { throw failure(error.message, 502); }
          json(res,200,{ connected:true });
        } else if (route === 'POST /assistant/chat') {
          if (!settings.assistant?.url) throw failure('请在设置中保存 API URL 和模型名。');
          const input = await jsonBody(req, 640 * 1024);
          try { json(res,200,await chatAssistant(settings.assistant, input)); }
          catch (error) { throw failure(error.message, 502); }
        } else if (route === 'POST /cache/clear') {
          const result = await oneAtATime(async () => {
            const stats = await sweep(settings.cacheLocation,true);
            let unavailable = 0;
            for (const location of new Set(settings.cacheLocations)) {
              if (location === settings.cacheLocation) continue;
              try { stats.removed += (await sweep(location,true)).removed; }
              catch { unavailable++; }
            }
            return { ...stats, unavailable };
          });
          json(res,200,result);
        } else if (route === 'POST /folder') {
          if (process.platform !== 'win32') throw failure('当前系统请直接输入文件夹路径。',501);
          if (picking) throw failure('目录选择窗口已打开。',409);
          picking = true;
          try {
            const start = url.searchParams.get('kind') === 'export' ? settings.exportLocation : settings.cacheLocation;
            if (selectFolder) {
              json(res,200,{folder:await selectFolder(start)});
              return;
            }
            const powershell = path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
            const result = await child(powershell,['-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',PICKER],
              {timeout:120000,windowsHide:true,env:{...process.env,RENDER_FOLDER_START:start}});
            if (result.code !== 0) throw failure('无法打开本机目录选择器，请直接输入路径。',422);
            json(res,200,{ folder:result.stdout });
          } finally { picking = false; }
        } else if (route === 'POST /mesh') {
          const exe = rhinoExe();
          if (!exe) throw failure('本机未找到 Rhino 8，无法自动生成曲面网格。可导入已带网格的 3DM 或 OBJ。',503);
          if (req.headers['content-type'] !== 'application/octet-stream') throw failure('无效的 3DM 请求。',415);
          if (meshQueue.length >= 3) throw failure('网格处理队列已满，请等待当前任务完成。',429);
          if (Number(req.headers['content-length'] || 0) > MESH_INPUT_LIMIT) {
            req.resume();
            throw failure('3DM 原文件超过 1 GiB。',413);
          }
          if (exclusive) {
            const granted = await new Promise(resolve => {
              const item = {id:requestId, start:() => { res.off('close', cancel); resolve(true); }};
              const cancel = () => {
                const index = meshQueue.indexOf(item);
                if (index >= 0) meshQueue.splice(index,1);
                resolve(false);
              };
              meshQueue.push(item);
              res.once('close',cancel);
            });
            if (!granted) return;
            if (res.destroyed) { releaseExclusive(); return; }
            exclusive = false;
          }
          await oneAtATime(async () => {
            const {cacheLocation} = await getSettings();
            await sweep(cacheLocation);
            activeMesh = {id:requestId,job:null};
            let converted;
            try {
              converted = await convertMesh(req,cacheLocation,exe,job => { activeMesh.job = job; });
            } finally { activeMesh = undefined; }
            const {output,cached} = converted;
            const {size} = await fs.stat(output);
            res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':size,
              'Cache-Control':'no-store','X-Render-Cache':cached?'hit':'created'});
            await new Promise((resolve,reject) => {
              const stream = createReadStream(output);
              stream.on('error',reject);
              res.once('close',() => { stream.destroy(); resolve(); });
              res.once('finish',resolve);
              stream.pipe(res);
            });
          });
        } else if (route === 'POST /export') {
          if (!settings.exportLocation && !selectExport) { req.resume(); json(res,200,{saved:false}); return; }
          if (req.headers['content-type'] !== 'image/png') throw failure('无效的 PNG 请求。',415);
          const bytes = await body(req,LIMIT);
          if (bytes.length < 33 || !bytes.subarray(0,8).equals(signature)) throw failure('图片不是有效的 PNG。',422);
          let stem = (url.searchParams.get('name') || '模型出图').replace(/\.png$/i,'')
            .replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').trim().slice(0,80).replace(/[. ]+$/,'') || '模型出图';
          if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = '_'+stem;
          if (!settings.exportLocation) {
            const target = await selectExport(stem+'.png');
            if (!target) { json(res,200,{saved:false,cancelled:true}); return; }
            await fs.writeFile(target,bytes);
            json(res,200,{saved:true,path:target});
            return;
          }
          const dir = await checkFolder(settings.exportLocation);
          const temp = path.join(dir,'.render-'+randomUUID()+'.tmp');
          await fs.writeFile(temp,bytes,{flag:'wx'});
          try {
            for (let i = 0; i < 1000; i++) {
              const target = path.join(dir,stem+(i?' ('+i+')':'')+'.png');
              try { await fs.link(temp,target); json(res,200,{saved:true,path:target}); return; }
              catch (e) {
                if (e.code === 'EEXIST') continue;
                if (e.code === 'ENOSYS' || e.code === 'ENOTSUP' || e.code === 'EPERM') {
                  try { await fs.copyFile(temp,target,1); json(res,200,{saved:true,path:target}); return; }
                  catch (copyError) { if (copyError.code === 'EEXIST') continue; throw copyError; }
                }
                throw e;
              }
            }
            throw failure('同名导出文件过多，请换一个题目。',409);
          } finally { await fs.unlink(temp).catch(() => {}); }
        } else json(res,404,{error:'本地接口不存在。'});
      } catch (error) {
        if (res.headersSent) { res.destroy(); return; }
        if (!error.status) console.error('[model workbench]',error);
        json(res,error.status || 500,{error:error.status ? error.message : '本机处理失败，请检查目录权限或服务日志。'});
      }
  }
  return {handle, close:() => clearInterval(interval)};
}

export function localWorkbench() {
  function setup(server) {
    const service = createWorkbenchService();
    server.httpServer?.once('close',service.close);
    server.middlewares.use('/api/workbench',service.handle);
  }
  return { name:'render-workbench-local', configureServer:setup, configurePreviewServer:setup };
}
