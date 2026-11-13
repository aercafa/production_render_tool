type CacheStats = { count: number; bytes: number; removed: number };
export type AssistantSettings = { url: string; model: string; key: string; keepKey: boolean };
export type LocalSettings = {
  cacheLocation: string;
  cacheFolder: string;
  exportLocation: string;
  cache: CacheStats | null;
  hours: number;
  rhinoAvailable: boolean;
  nativeSave: boolean;
  assistant: { url: string; model: string; hasKey: boolean };
};

async function request(route: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  headers.set('X-Render-Workbench', 'local-v1');
  let response: Response;
  try { response = await fetch('/api/workbench/' + route, { ...options, headers }); }
  catch { throw new Error('无法连接本机工作台服务，请重新启动工作台后重试。'); }
  if (!response.ok || response.headers.get('content-type')?.includes('text/html')) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.error || '本机工作台服务未响应，请通过本地启动命令打开页面。');
  }
  return response;
}

export type OperationProgress = (message: string, percent?: number, detail?: string) => void;

export async function prepareMesh(body: ArrayBuffer, onProgress?: OperationProgress) {
  const id = crypto.randomUUID();
  const tracking = new AbortController();
  let timer: number | undefined;
  const poll = async () => {
    try {
      const response = await request('mesh/progress?id=' + id, { signal: tracking.signal });
      const state = await response.json() as { stage?: string; completed?: number; total?: number };
      if (tracking.signal.aborted) return;
      if (state.stage === 'rhino') onProgress?.('正在启动 Rhino 网格处理…');
      if (state.stage === 'meshing' && state.total && state.completed !== undefined) {
        const percent = Math.round(state.completed / state.total * 100);
        onProgress?.('正在生成显示网格…', percent, state.completed + ' / ' + state.total);
      }
      if (state.stage === 'writing') onProgress?.('正在写入网格缓存…');
    } catch { /* The import response reports conversion errors. */ }
    if (!tracking.signal.aborted) timer = window.setTimeout(poll, 400);
  };
  if (onProgress) timer = window.setTimeout(poll, 200);
  try {
    const response = await request('mesh?id=' + id, {
      method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream' },
    });
    tracking.abort();
    onProgress?.('正在读取处理后的网格…');
    return { buffer: await response.arrayBuffer(), cached: response.headers.get('X-Render-Cache') === 'hit' };
  } finally {
    tracking.abort();
    window.clearTimeout(timer);
  }
}

export async function readSettings(): Promise<LocalSettings> {
  return (await request('settings')).json();
}

export async function writeSettings(cacheLocation: string, exportLocation: string, assistant?: AssistantSettings) {
  await request('settings', { method: 'PUT', body: JSON.stringify({ cacheLocation, exportLocation, assistant }),
    headers: { 'Content-Type': 'application/json' } });
}

export async function testAssistant(config: AssistantSettings) {
  await request('assistant/test', { method: 'POST', body: JSON.stringify(config),
    headers: { 'Content-Type': 'application/json' } });
}

export type ChatMessage = { role: 'user' | 'assistant'; content: string };

export async function askAssistant(messages: ChatMessage[], scene: object): Promise<{ reply: string; changes: unknown[] }> {
  const response = await request('assistant/chat', { method: 'POST', body: JSON.stringify({ messages, scene }),
    headers: { 'Content-Type': 'application/json' } });
  return response.json();
}

export async function chooseFolder(kind: 'cache' | 'export'): Promise<{ folder: string }> {
  return (await request('folder?kind=' + kind, { method: 'POST' })).json();
}

export async function clearCache(): Promise<CacheStats & { unavailable?: number }> {
  return (await request('cache/clear', { method: 'POST' })).json();
}

export async function saveLocalExport(name: string, body: Blob): Promise<{ saved: boolean; path?: string; cancelled?: boolean }> {
  return (await request('export?name=' + encodeURIComponent(name), {
    method: 'POST', body, headers: { 'Content-Type': 'image/png' },
  })).json();
}
