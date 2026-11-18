import type { MaterialSnapshot, SceneValues } from './assistant-edits';
import { blankNotes, type Notes } from './annotations';
import type { ImportSource } from './local-service';

export type RenderRecord = {
  id: string; modelKey: string; modelName: string; at: number; updatedAt: number; source: ImportSource;
  thumbnail: string; scene: SceneValues; view: number; materials: MaterialSnapshot;
  notes: Notes; unit: string;
};
const storageKey = 'render-workbench.import-history.v2';
const limit = 18;

export const renderHistoryMarkup = `
<section class="render-history" aria-labelledby="render-history-heading">
  <header class="history-head"><h2 id="render-history-heading">渲染历史 <span id="history-count">0</span></h2>
    <button id="history-clear" class="link" type="button">清空</button></header>
  <div id="history-list" class="history-list" aria-label="渲染历史记录"></div>
  <p id="history-hint" class="hint">每次导入一条记录，自动保留最后效果。</p>
</section>
<dialog id="history-detail" class="history-detail" aria-labelledby="history-detail-heading">
  <header class="history-head"><h2 id="history-detail-heading">历史渲染</h2><button id="history-detail-close" type="button">关闭</button></header>
  <img id="history-detail-image" alt="历史渲染预览"><p id="history-detail-info"></p>
  <button id="history-reselect" class="primary" type="button">重新选择源文件</button>
</dialog>`;

/** Hash every source byte in bounded chunks; large CAD files are never copied in full. */
export async function renderModelKey(files: File[]) {
  const identities = [];
  for (const file of [...files].sort((a,b) => a.name.localeCompare(b.name))) {
    const chunks = [];
    for (let offset=0; offset<file.size; offset+=4*1024*1024) {
      const digest = await crypto.subtle.digest('SHA-256',await file.slice(offset,offset+4*1024*1024).arrayBuffer());
      chunks.push([...new Uint8Array(digest)]);
    }
    identities.push({ name:file.name, size:file.size, chunks });
  }
  const hash = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(identities)));
  return [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2,'0')).join('');
}

function validScene(value: unknown): value is SceneValues {
  const s = value as SceneValues | null;
  const within = (n: unknown,low: number,high: number) => typeof n === 'number' && Number.isFinite(n) && n >= low && n <= high;
  return !!s && ['premium','studio','clay'].includes(s.style) && Number.isInteger(s.exposure) && within(s.exposure,-10,10)
    && within(s.ao,0,1) && within(s.shadow,0,1) && within(s.reflection,0,2) && within(s.lightZ,-180,180) && within(s.lightY,-180,180);
}
function loadRecords(): RenderRecord[] {
  try {
    const stored=localStorage.getItem(storageKey);
    const entries: unknown = JSON.parse(stored ?? localStorage.getItem('render-workbench.history.v1') ?? '[]');
    if (!Array.isArray(entries)) return [];
    const seen=new Set<string>();
    return entries.filter(e => !!e && typeof e.id === 'string' && typeof e.modelKey === 'string'
      && typeof e.modelName === 'string' && Number.isFinite(e.at)
      && typeof e.thumbnail === 'string' && e.thumbnail.startsWith('data:image/jpeg;base64,') && e.thumbnail.length < 500000
      && validScene(e.scene) && Number.isInteger(e.view) && e.view >= 0 && e.view < 6
      && Array.isArray(e.materials) && e.materials.length < 10000)
      .filter(e=>{const key=stored?e.id:e.modelKey;if(seen.has(key))return false;seen.add(key);return true;})
      .map(e=>({...e,updatedAt:e.updatedAt??e.at,notes:e.notes??blankNotes(),unit:typeof e.unit==='string'?e.unit:'',
        source:e.source&&Array.isArray(e.source.files)?e.source:{kind:'legacy',files:[{name:e.modelName,size:0,modified:0}]}})).slice(0,limit);
  } catch { return []; }
}

export function bindRenderHistory(options: { flush: () => void; restore: (entry: RenderRecord) => Promise<void>; reselect: (entry: RenderRecord) => void }) {
  const get = <T extends HTMLElement=HTMLElement>(id:string) => document.getElementById(id) as T;
  const list = get('history-list');
  const clear = get<HTMLButtonElement>('history-clear');
  const dialog = get<HTMLDialogElement>('history-detail');
  let records = loadRecords();
  let draft: Pick<RenderRecord,'id'|'modelKey'|'modelName'|'at'|'source'> | undefined;
  let locked = false;
  let volatile = false;
  let active = '';
  let restoring = false;
  let errorMessage = '';
  let detail: RenderRecord | undefined;
  const persist = () => {
    try { localStorage.setItem(storageKey,JSON.stringify(records)); volatile = false; }
    catch { volatile = true; }
  };
  function render() {
    const scroll=list.scrollTop;
    clear.disabled = locked || restoring || !records.length;
    list.replaceChildren();
    const visible = records;
    get('history-count').textContent = String(visible.length);
    get('history-hint').textContent = errorMessage || (volatile ? '存储不可用，记录仅在本次页面保留。' : '每次导入一条 · 自动保留最后效果 · 最近 18 次');
    if (!visible.length) {
      const empty = document.createElement('p');empty.className='history-empty';
      empty.textContent = '导入模型后，在这里回查缩略图、导入时间与来源。';
      list.append(empty);
    }
    for (let entry of visible) {
      const button=document.createElement('button');button.type='button';button.className='history-card';
      button.dataset.record=entry.id;button.setAttribute('aria-pressed',String(entry.id===active));
      button.setAttribute('aria-label','回查渲染记录 '+new Date(entry.at).toLocaleString('zh-CN')+' '+entry.modelName);
      button.disabled=locked||restoring;
      const location=entry.source.files.find(file=>/\.(3dm|obj)$/i.test(file.name))??entry.source.files[0];
      const sourcePath=location?.path || (entry.source.kind==='drop'?'拖拽导入':entry.source.kind==='legacy'?'旧版来源未记录':'浏览器选择（未提供完整路径）');
      button.title=entry.modelName+'\n导入：'+new Date(entry.at).toLocaleString('zh-CN')+'\n来源：'+sourcePath;
      const img=new Image();img.src=entry.thumbnail;img.alt='';img.loading='lazy';
      const text=document.createElement('span');text.className='history-card-text';
      const title=document.createElement('strong');title.textContent=entry.modelName;
      const source=document.createElement('span');source.className='history-source';source.textContent=sourcePath;source.title=sourcePath;
      const time=document.createElement('time');time.dateTime=new Date(entry.at).toISOString();
      time.textContent=new Date(entry.at).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
      text.append(title,time,source);button.append(img,text);
      button.onclick=async()=>{
        options.flush();entry=records.find(item=>item.id===entry.id)??entry;
        const previous=draft;
        errorMessage='';restoring=true;render();
        try{await options.restore(structuredClone(entry));active=entry.id;draft={id:entry.id,modelKey:entry.modelKey,modelName:entry.modelName,at:entry.at,source:entry.source};}
        catch(error){
          draft=previous;errorMessage=error instanceof Error?error.message:'恢复记录失败。';detail=entry;
          get<HTMLImageElement>('history-detail-image').src=entry.thumbnail;
          get('history-detail-info').textContent=entry.modelName+'\n导入时间：'+new Date(entry.at).toLocaleString('zh-CN')+'\n来源：'+sourcePath+'\n'+errorMessage;
          dialog.showModal();
        }
        finally{restoring=false;render();}
      };
      list.append(button);
    }
    list.scrollTop=scroll;
  }
  clear.onclick=()=>{records=[];active='';draft=undefined;persist();render();};
  get('history-detail-close').onclick=()=>dialog.close();
  get('history-reselect').onclick=()=>{dialog.close();if(detail)options.reselect(detail);};
  persist();render();
  return {
    begin(modelKey:string,modelName:string,source:ImportSource,record?:RenderRecord){
      draft={id:record?.id??crypto.randomUUID(),modelKey,modelName,source,at:record?.at??Date.now()};
      active=draft.id;errorMessage='';render();list.scrollTop=0;return active;
    },
    currentKey:()=>draft?.modelKey,
    currentId:()=>draft?.id,
    setLocked(value:boolean){if(locked!==value){locked=value;render();}},
    update(entry:Pick<RenderRecord,'thumbnail'|'scene'|'view'|'materials'|'notes'|'unit'>){
      if(!draft||restoring)return;
      const signature=(e:typeof entry)=>JSON.stringify([e.scene,e.view,e.materials,e.notes,e.unit]);
      const previous=records.find(e=>e.id===draft!.id);
      if(previous&&signature(previous)===signature(entry))return;
      const next={...structuredClone(entry),...draft,updatedAt:Date.now()};
      if(previous)records=records.map(e=>e.id===next.id?next:e);
      else records=[next,...records].slice(0,limit);
      active=next.id;errorMessage='';persist();render();
    },
  };
}
