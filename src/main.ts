import './style.css';
import { version } from '../package.json';
import { blankNotes, constrainLine, distanceToSegment, moveEndpoint, NoteHistory, type Axis, type Endpoint,
  type LabelSide, type LineMode, type Mark, type Notes, type Point } from './annotations';
import type { Rect } from './mark-label';
import { disposeModel, loadModel, measured, unitChoices, type RenderModel } from './model';
import { drawEmpty, drawNotes, mainViews, SheetRenderer, SHEET_HEIGHT, SHEET_WIDTH } from './sheet';
import { modelCaption, pngFileName, withPrintResolution } from './export';
import { nativeModelFiles, readSettings, saveLocalExport, type ImportSource } from './local-service';
import { bindSettings, settingsMarkup } from './settings';
import type { RenderStyle } from './view-effects';
import { exposureControl } from './render-config';
import { assistantMarkup, bindAssistant } from './assistant-panel';
import { defaultTuning, type AssistantEdits, type SceneValues } from './assistant-edits';
import { bindRenderHistory, renderHistoryMarkup, renderModelKey, type RenderRecord } from './render-history';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = [
  '<header class="topbar"><div class="brand"><span class="brand-logo" aria-hidden="true">',
  '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/></svg>',
  '</span><div><h1>模型出图工作台 <small class="brand-version">v' + version + '</small></h1></div></div>',
  '<div class="top-actions"><button id="settings-button" class="quiet" aria-haspopup="dialog">设置</button><button id="open" class="import-button"><span aria-hidden="true">＋</span> 导入模型</button></div></header>',
  '<input id="file" type="file" accept=".obj,.3dm,.mtl,.png,.jpg,.jpeg,.webp,.gif" multiple hidden>',
  '<main class="shell has-assistant"><div id="left-rail" class="left-rail">', renderHistoryMarkup, assistantMarkup, '</div><section class="workspace" aria-label="成图预览"><div class="stage-head">',
  '<div class="stage-leading"><button id="assistant-toggle" class="assistant-toggle" aria-controls="left-rail" aria-expanded="true">渲染助手</button>',
  '<label class="view-select style-select">渲染风格<select id="render-style" aria-label="渲染风格">',
  '<option value="studio">棚拍材质</option><option value="premium">高保真棚拍</option><option value="clay">灰白模 · 线描</option></select></label></div>',
  '<div class="stage-tools"><label class="view-select">主视角<select id="main-view" aria-label="主视角">',
  mainViews.map((view, i) => '<option value="' + i + '">' + view.label + '</option>').join(''),
  '</select></label><div class="tool-group" role="group" aria-label="标注工具"><button id="select-tool" aria-pressed="true">选择</button>',
  '<button id="draw" aria-pressed="false">绘制辅助线</button></div><div class="tool-group" role="group" aria-label="标注历史">',
  '<button id="undo" title="撤回标注 (Ctrl+Z)" disabled>撤回</button><button id="redo" title="重做标注 (Ctrl+Shift+Z)" disabled>重做</button></div>',
  '<div class="tool-group" role="group" aria-label="渲染修改历史"><button id="render-undo" type="button" title="撤销上一次助手修改" disabled>撤销渲染</button>',
  '<button id="assistant-compare" type="button" aria-label="按住对比修改前" title="按住看修改前，松开恢复" aria-pressed="false" disabled>',
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12 3v18M7 9v6M17 9v6"/></svg> 对比</button></div></div></div>',
  '<div class="status" id="status"><div class="status-content"><span id="message" role="status" aria-live="polite">请选择或拖入模型。</span>',
  '<div id="operation-progress" class="operation-progress" hidden><progress id="progress" aria-label="处理进度"></progress><span id="progress-count" aria-hidden="true"></span></div></div></div>',
  '<div class="stage"><div class="paper" id="paper"><canvas id="base" width="1200" height="800" aria-label="模型四视图"></canvas>',
  '<canvas id="compare-frame" hidden aria-hidden="true"></canvas>',
  '<canvas id="overlay" class="overlay" width="1200" height="800" aria-label="标注画布"></canvas>',
  '<span id="compare-badge" class="canvas-badge" hidden>修改前</span>',
  '<span id="render-refresh" class="canvas-badge" hidden><span class="assistant-spinner" aria-hidden="true"></span> 正在刷新预览…</span>',
  '<div class="drop-message">释放以导入模型</div></div></div>',
  '</section>',
  '<aside class="panel" aria-label="出图设置"><div class="panel-content"><section class="section"><h2><span class="step">1</span>模型</h2>',
  '<div class="model-info"><div style="min-width:0"><strong id="name">未导入模型</strong><span id="info">选择 OBJ 或 3DM</span></div><span id="model-type" class="tag" hidden></span></div>',
  '<label class="field unit" id="unit-row" hidden>OBJ 源文件单位<select id="unit" aria-label="OBJ 源文件单位"><option value="">未知</option><option value="mm">毫米 (mm)</option><option value="cm">厘米 (cm)</option><option value="m">米 (m)</option><option value="in">英寸 (in)</option><option value="ft">英尺 (ft)</option></select></label>',
  '<p class="hint">可拖放文件。OBJ 的 MTL 和贴图可一起选择。</p></section>',
  '<section class="section" id="editor" hidden><h2><span class="step">2</span>完善标注</h2>',
  '<div class="input-group"><label class="field">题目<input id="title" maxlength="70" placeholder="键入题目"></label>',
  '<label class="field">辅助说明<textarea id="subtitle" maxlength="180" rows="2" placeholder="键入辅助说明"></textarea></label></div>',
  '<div class="row dim-head"><strong>外形尺寸</strong><button class="link" id="reset-dim">恢复实测</button></div>',
  '<div class="dim-list">',
  '<label class="dim">总宽<input id="dim-width" aria-label="总宽标注" maxlength="30"><span class="source" id="source-width"></span></label>',
  '<label class="dim">总深<input id="dim-depth" aria-label="总深标注" maxlength="30"><span class="source" id="source-depth"></span></label>',
  '<label class="dim">总高<input id="dim-height" aria-label="总高标注" maxlength="30"><span class="source" id="source-height"></span></label>',
  '</div><div class="section-title"><div class="row dim-head"><strong>局部尺寸 / 辅助线</strong><button id="undo-mark" title="Ctrl+Z" disabled>撤回标注</button></div>',
  '<button id="draw-panel" class="draw-panel" aria-pressed="false">绘制辅助线</button>',
  '<div class="line-tools"><label class="field">拉线方向<select id="line-mode" aria-label="拉线方向">',
  '<option value="orthogonal">正交自动</option><option value="free">自由</option></select></label>',
  '<label class="field">文字位置<select id="label-side" aria-label="文字位置" disabled>',
  '<option value="auto">自动避让</option><option value="near">左侧 / 上方</option><option value="far">右侧 / 下方</option></select></label></div>',
  '<p class="hint" id="draw-hint">点选画布上的线，再拖动端点。</p>',
  '<div id="mark-list" class="mark-list"></div></div>',
  '<div class="exposure-control"><div class="row exposure-head"><label for="exposure">曝光</label>',
  '<span id="exposure-value" aria-hidden="true">0</span><button id="reset-exposure" class="link" type="button" aria-label="重置曝光">重置</button></div>',
  '<input id="exposure" type="range" min="' + exposureControl.min + '" max="' + exposureControl.max +
    '" step="1" value="' + exposureControl.default + '">',
  '<div class="exposure-ticks" aria-hidden="true"><span>−10</span><span>0</span><span>+10</span></div></div>',
  '<div id="premium-controls" class="light-controls" hidden><div class="row light-heading"><strong>高保真 · 光箱方向</strong><button id="reset-light" class="link" type="button">归零</button></div>',
  '<label class="angle-control" for="light-z"><span>光箱 Z 轴角度 <small>水平转</small></span><span id="light-z-value" aria-hidden="true">0°</span></label>',
  '<input id="light-z" aria-label="光箱 Z 轴角度" type="range" min="-180" max="180" step="1" value="0">',
  '<div class="exposure-ticks" aria-hidden="true"><span>−180°</span><span>0°</span><span>180°</span></div>',
  '<label class="angle-control" for="light-y"><span>光箱 Y 轴角度 <small>垂直转</small></span><span id="light-y-value" aria-hidden="true">0°</span></label>',
  '<input id="light-y" aria-label="光箱 Y 轴角度" type="range" min="-180" max="180" step="1" value="0">',
  '<div class="exposure-ticks" aria-hidden="true"><span>−180°</span><span>0°</span><span>180°</span></div></div></section></div>',
  '<footer class="panel-footer"><div class="download-row"><strong>成图导出</strong><span>6000 × 4000 px</span></div>',
  '<button id="export" class="primary export-button" disabled>导出 PNG</button></footer></aside></main>',
  settingsMarkup,
].join('');

function el<T extends HTMLElement = HTMLElement>(id: string) { return document.getElementById(id) as T; }
const base = el<HTMLCanvasElement>('base');
const overlay = el<HTMLCanvasElement>('overlay');
const baseContext = base.getContext('2d')!;
const overlayContext = overlay.getContext('2d')!;
const filePicker = el<HTMLInputElement>('file');
const openButton = el<HTMLButtonElement>('open');
const exportButton = el<HTMLButtonElement>('export');
const undoButton = el<HTMLButtonElement>('undo');
const undoMarkButton = el<HTMLButtonElement>('undo-mark');
const redoButton = el<HTMLButtonElement>('redo');
const drawButton = el<HTMLButtonElement>('draw');
const drawPanel = el<HTMLButtonElement>('draw-panel');
const selectButton = el<HTMLButtonElement>('select-tool');
const viewChoice = el<HTMLSelectElement>('main-view');
const styleChoice = el<HTMLSelectElement>('render-style');
const exposureSlider = el<HTMLInputElement>('exposure');
const exposureOutput = el('exposure-value');
const resetExposure = el<HTMLButtonElement>('reset-exposure');
const lightZ = el<HTMLInputElement>('light-z');
const lightY = el<HTMLInputElement>('light-y');
const resetLight = el<HTMLButtonElement>('reset-light');
const lineMode = el<HTMLSelectElement>('line-mode');
const labelSide = el<HTMLSelectElement>('label-side');
const unit = el<HTMLSelectElement>('unit');
const titleInput = el<HTMLInputElement>('title');
const subtitleInput = el<HTMLTextAreaElement>('subtitle');
const markList = el('mark-list');
const paper = el('paper');
const axes: Axis[] = ['width', 'depth', 'height'];

let renderer: SheetRenderer | null = null;
let model: RenderModel | null = null;
const history = new NoteHistory();
let selected: number | null = null;
let draft: Mark | null = null;
let labelBounds = new Map<number, Rect>();
type Interaction = { pointer: number; type: 'draw' } |
  { pointer: number; type: 'edit'; original: Mark; endpoint: Endpoint; offset: Point };
let interaction: Interaction | null = null;
let drawMode = false;
let markId = 1;
let busy = false;
let pickingModel = false;
let nativeImportAvailable = false;
let importCapabilitiesReady = false;
let reselectRecord: RenderRecord | undefined;
let historyTimer: number | undefined;
const sessionFiles = new Map<string, File[]>();
let blocked = false;
let exportPending = false;
let previewScale = 1;
let exposureFrame = 0;
let nextLineMode: LineMode = 'orthogonal';
const selectedView = () => Number(viewChoice.value);
const selectedStyle = () => styleChoice.value as RenderStyle;
let tuning = { ...defaultTuning };
let assistantRendering = false;
let pickingPart = false;
let comparison: ReturnType<AssistantEdits['beforeLastEdit']>;
let comparisonView = -1;
const compareButton = el<HTMLButtonElement>('assistant-compare');
const compareFrame = el<HTMLCanvasElement>('compare-frame');
function showBefore(show: boolean) {
  let active = show && !compareButton.disabled;
  if (active) {
    try { renderComparison(); }
    catch { active = false; status('暂时无法绘制对比画面，请重试。', 'error'); }
  }
  compareFrame.hidden = el('compare-badge').hidden = !active;
  compareButton.setAttribute('aria-pressed', String(active));
}
function resetComparison() {
  comparison = undefined;
  comparisonView = -1;
  showBefore(false);
  compareFrame.width = compareFrame.height = 0;
  compareButton.disabled = true;
}
function sizeComparison() {
  compareFrame.width = base.width;
  compareFrame.height = base.height;
  return compareFrame.getContext('2d')!;
}
function renderComparison() {
  const view = selectedView();
  if (!renderer || !comparison || (view === comparisonView && compareFrame.width === base.width)) return;
  const { scene, overrides } = comparison;
  comparisonView = -1;
  try {
    renderer.setTuning(scene);
    renderer.setMaterialOverrides(overrides);
    renderer.preview(sizeComparison(), previewScale, view, scene.style, scene.exposure);
    comparisonView = view;
  } finally {
    renderer.setTuning(tuning);
    renderer.setMaterialOverrides(assistant.overrides());
  }
}
const assistant = bindAssistant({
  scene: (): SceneValues => ({ ...tuning, style: selectedStyle(), exposure: exposureSlider.valueAsNumber }),
  picking: enabled => {
    pickingPart = enabled;
    overlay.dataset.pick = String(enabled);
    if (enabled) { cancelInteraction(); drawing(false); }
  },
  previewImage: () => {
    const image = document.createElement('canvas');
    image.width = 1008;
    image.height = 672;
    const context = image.getContext('2d')!;
    context.imageSmoothingQuality = 'high';
    context.drawImage(base,0,0,image.width,image.height);
    return image.toDataURL('image/jpeg', .78);
  },
  render: async (scene, edits, compare) => {
    if (compare) {
      if (exposureFrame) {
        cancelAnimationFrame(exposureFrame);
        exposureFrame = 0;
        renderPreview();
      }
      sizeComparison().drawImage(base, 0, 0);
      comparisonView = selectedView();
    }
    else comparisonView = -1;
    assistantRendering = true;
    showBefore(false);
    const refreshing = el('render-refresh');
    refreshing.hidden = false;
    updateButtons();
    try {
      await new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
      tuning = { ao: scene.ao, shadow: scene.shadow, reflection: scene.reflection, lightZ: scene.lightZ, lightY: scene.lightY };
      styleChoice.value = scene.style;
      exposureSlider.valueAsNumber = scene.exposure;
      renderer?.setTuning(tuning);
      renderer?.setMaterialOverrides(edits.overrides());
      updateExposure();
      updateLightControls();
      renderPreview();
      comparison = edits.beforeLastEdit();
      status(compare ? '渲染已更新 · 按住「对比」查看修改前' : '已恢复上一次助手修改。', 'success');
      captureRender(compare ? '材质与效果调整' : '撤销渲染修改');
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
        base.animate([{ opacity:.65 }, { opacity:1 }], { duration:220 });
      }
    } finally {
      refreshing.hidden = true;
      assistantRendering = false;
      fitPreview();
      updateButtons();
    }
  },
});
bindSettings(() => void assistant.refreshSettings());
const renderHistory = bindRenderHistory({
  flush: () => { window.clearTimeout(historyTimer);captureRender(); },
  restore: async entry => {
    captureRender();
    if(model&&renderHistory.currentKey()===entry.modelKey&&!blocked){
      await restoreRecordState(entry);
      renderHistory.begin(entry.modelKey,entry.modelName,entry.source,entry);
    }else{
      const cached=sessionFiles.get(entry.id);
      let selected=cached?{files:cached,source:entry.source}:null;
      if(!selected&&entry.source.nativeId){
        showProgress('正在读取历史模型…');
        try{selected=await nativeModelFiles(entry.source.nativeId);}finally{hideProgress();}
      }
      if(!selected)throw new Error('请选择这次导入的源文件，以恢复模型和最后效果。');
      if(!await importModel(selected.files,selected.source,entry))throw new Error(el('message').textContent||'历史模型载入失败。');
      await restoreRecordState(entry);
    }
    status('已恢复「'+entry.modelName+'」的最后效果。','success');
  },
  reselect: entry => void openModelPicker(entry),
});
async function restoreRecordState(entry: RenderRecord) {
  const previousView=selectedView();
  viewChoice.value=String(entry.view);
  if(previousView!==entry.view){comparisonView=-1;renderPreview();redraw();}
  try {
    await assistant.restore(entry.materials,entry.scene);
    if(model?.kind==='OBJ'){
      model.unit=Object.hasOwn(unitChoices,entry.unit)?entry.unit:'';
      model.unitFactor=unitChoices[model.unit]??null;unit.value=model.unit;
    }
    history.commit(structuredClone(entry.notes));selected=null;sync();
  }catch(error){viewChoice.value=String(previousView);renderPreview();redraw();throw error;}
}
function captureRender(_label?: string) {
  if (!model || !renderer || blocked) return;
  const thumbnail=document.createElement('canvas');thumbnail.width=900;thumbnail.height=600;
  const ctx=thumbnail.getContext('2d')!;
  ctx.imageSmoothingQuality='high';ctx.drawImage(base,0,0,900,600);
  drawNotes(ctx,900/SHEET_WIDTH,model,history.current,{preset:selectedView(),offset:{x:0,y:0}});
  renderHistory.update({thumbnail:thumbnail.toDataURL('image/jpeg',.82),
    scene:{...tuning,style:selectedStyle(),exposure:exposureSlider.valueAsNumber},view:selectedView(),materials:assistant.snapshot(),
    notes:structuredClone(history.current),unit:model.unit});
}
function queueRenderHistory(){window.clearTimeout(historyTimer);historyTimer=window.setTimeout(()=>captureRender(),180);}
void readSettings().then(settings=>{nativeImportAvailable=settings.nativeImport;}).catch(()=>{}).finally(()=>{importCapabilitiesReady=true;updateButtons();});
window.addEventListener('pagehide',()=>captureRender());
const assistantToggle = el<HTMLButtonElement>('assistant-toggle');
const assistantPanel = el('left-rail');
assistantToggle.onclick = () => {
  assistantPanel.hidden = !assistantPanel.hidden;
  assistantPanel.parentElement?.classList.toggle('has-assistant', !assistantPanel.hidden);
  assistantToggle.setAttribute('aria-expanded', String(!assistantPanel.hidden));
};
if (window.matchMedia('(max-width: 1050px)').matches) assistantToggle.click();
compareButton.onpointerdown = event => {
  if (event.button !== 0 || compareButton.disabled) return;
  compareButton.setPointerCapture(event.pointerId);
  showBefore(true);
};
compareButton.onpointerup = compareButton.onpointercancel = compareButton.onlostpointercapture = () => showBefore(false);
compareButton.onkeydown = event => {
  if (event.key !== ' ' && event.key !== 'Enter') return;
  event.preventDefault();
  showBefore(true);
};
compareButton.onkeyup = event => {
  if (event.key !== ' ' && event.key !== 'Enter') return;
  event.preventDefault();
  showBefore(false);
};
compareButton.onblur = () => showBefore(false);
window.addEventListener('blur', () => showBefore(false));

function status(message: string, kind = 'info') {
  el('status').dataset.kind = kind;
  el('message').textContent = message;
}

function showProgress(message: string, percent?: number, detail = '') {
  if (el('message').textContent !== message) status(message);
  const progress = el<HTMLProgressElement>('progress');
  if (percent === undefined) progress.removeAttribute('value');
  else { progress.max = 100; progress.value = percent; }
  progress.setAttribute('aria-valuetext', [message, detail].filter(Boolean).join(' '));
  el('progress-count').textContent = detail;
  el('operation-progress').hidden = false;
}

function hideProgress() {
  el('operation-progress').hidden = true;
}

function drawing(enabled: boolean) {
  if (enabled && pickingPart) assistant.cancelPicking();
  drawMode = enabled;
  overlay.dataset.tool = enabled ? 'line' : '';
  overlay.dataset.target = '';
  drawButton.setAttribute('aria-pressed', String(enabled));
  drawPanel.setAttribute('aria-pressed', String(enabled));
  selectButton.setAttribute('aria-pressed', String(!enabled));
  if (enabled) selected = null;
  updateSelection();
  redraw();
}

function redraw() {
  labelBounds = drawNotes(overlayContext, previewScale, model, history.current, {
    selected, draft, preset: selectedView(), handleRadius: 4 * sheetUnitsPerPixel(),
  });
  if(model&&!busy&&!exportPending&&!assistantRendering)queueRenderHistory();
}

function renderPreview() {
  if (renderer && model) {
    renderer.setTuning(tuning);
    renderer.preview(baseContext, previewScale, selectedView(), selectedStyle(), exposureSlider.valueAsNumber);
  }
  else drawEmpty(baseContext, previewScale);
}

function fitPreview() {
  if (exportPending || assistantRendering) return;
  const cssWidth = paper.getBoundingClientRect().width;
  if (cssWidth === 0) return;
  const width = Math.max(3, Math.ceil(Math.min(3000, cssWidth * window.devicePixelRatio * 1.25) / 3) * 3);
  if (width === base.width) return;
  base.width = overlay.width = width;
  base.height = overlay.height = width / 3 * 2;
  previewScale = width / SHEET_WIDTH;
  renderPreview();
  redraw();
  if (!compareFrame.hidden) showBefore(true);
}

function updateButtons() {
  const busyRendering = busy || pickingModel || exportPending || assistantRendering;
  openButton.disabled = busyRendering || !importCapabilitiesReady;
  exportButton.disabled = !model || busyRendering || blocked;
  exportButton.textContent = exportPending ? '正在导出…' : '导出 PNG';
  undoButton.disabled = !history.canUndo;
  undoMarkButton.disabled = !history.canUndo;
  redoButton.disabled = !history.canRedo;
  drawButton.disabled = !model || busy;
  drawPanel.disabled = drawButton.disabled;
  selectButton.disabled = !model || busy;
  viewChoice.disabled = !model || busyRendering;
  styleChoice.disabled = viewChoice.disabled;
  exposureSlider.disabled = viewChoice.disabled || selectedStyle() === 'clay';
  resetExposure.disabled = exposureSlider.disabled || exposureSlider.valueAsNumber === exposureControl.default;
  compareButton.disabled = !comparison || busyRendering || blocked;
  if (compareButton.disabled) showBefore(false);
  assistant.setLocked(busyRendering || blocked);
  renderHistory.setLocked(busyRendering || !importCapabilitiesReady);
  el('premium-controls').hidden=selectedStyle()!=='premium';
  lightZ.disabled=lightY.disabled=viewChoice.disabled||selectedStyle()!=='premium';
  resetLight.disabled=lightZ.disabled||(tuning.lightZ===0&&tuning.lightY===0);
}

function updateSelection() {
  const mark = history.current.marks.find(m => m.id === selected);
  lineMode.value = mark?.mode ?? nextLineMode;
  labelSide.disabled = !mark;
  labelSide.value = mark?.side ?? 'auto';
  for (const row of markList.querySelectorAll<HTMLElement>('.mark-row')) {
    const active = Number(row.dataset.markId) === selected;
    row.classList.toggle('is-selected', active);
    row.querySelector('button')?.setAttribute('aria-pressed', String(active));
  }
  el('draw-hint').textContent = drawMode ? '在图纸上按住拖动；松开后填写局部尺寸。' :
    mark ? '拖动蓝色端点调整，文字位置可在上方切换。' : '点选画布上的线，再拖动端点。';
}

function selectMark(id: number | null) {
  selected = id;
  updateSelection();
  redraw();
}

function syncDimensions() {
  for (const axis of axes) {
    const input = el<HTMLInputElement>('dim-' + axis);
    const actual = model ? measured(model, axis) : '';
    input.placeholder = actual || '手填标注';
    const override = history.current.dimensions[axis];
    const source = el('source-' + axis);
    source.textContent = override ? (actual ? '已替换' : '手填值') : (actual ? '实测值' : '单位未知');
    source.title = actual ? '网格范围换算：' + actual : '没有可用于计算的源单位';
  }
  el<HTMLButtonElement>('reset-dim').disabled = !Object.values(history.current.dimensions).some(Boolean);
}

function bindEdit(input: HTMLInputElement | HTMLTextAreaElement, change: (notes: Notes, value: string) => Notes) {
  let baseline: Notes | null = null;
  input.addEventListener('focus', () => { baseline = history.current; });
  input.addEventListener('input', () => {
    baseline ??= history.current;
    history.current = change(history.current, input.value);
    syncDimensions();
    redraw();
  });
  input.addEventListener('blur', () => {
    if (baseline) history.commit(history.current, baseline);
    baseline = null;
    updateButtons();
  });
  if (input instanceof HTMLInputElement) {
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing) input.blur();
    });
  }
}

function syncMarkList() {
  markList.replaceChildren();
  history.current.marks.forEach((mark, index) => {
    const row = document.createElement('div');
    row.className = 'mark-row';
    row.dataset.markId = String(mark.id);
    const n = document.createElement('button');
    n.textContent = String(index + 1).padStart(2, '0');
    n.className = 'mark-index';
    n.setAttribute('aria-label', '选中辅助线 ' + (index + 1));
    n.onclick = () => { drawing(false); selectMark(mark.id); };
    const input = document.createElement('input');
    input.setAttribute('aria-label', '局部尺寸 ' + (index + 1));
    input.dataset.mark = String(mark.id);
    input.placeholder = '键入局部尺寸';
    input.maxLength = 36;
    input.value = mark.value;
    input.addEventListener('focus', () => selectMark(mark.id));
    bindEdit(input, (notes, value) => ({ ...notes, marks: notes.marks.map(m => m.id === mark.id ? { ...m, value } : m) }));
    const del = document.createElement('button');
    del.textContent = '删除';
    del.setAttribute('aria-label', '删除辅助线 ' + (index + 1));
    del.onclick = () => {
      selected = null;
      history.commit({ ...history.current, marks: history.current.marks.filter(m => m.id !== mark.id) });
      sync();
    };
    row.append(n, input, del);
    markList.append(row);
  });
}

function sync() {
  titleInput.value = history.current.title;
  subtitleInput.value = history.current.subtitle;
  for (const axis of axes) el<HTMLInputElement>('dim-' + axis).value = history.current.dimensions[axis];
  syncDimensions();
  syncMarkList();
  updateSelection();
  updateButtons();
  redraw();
}

bindEdit(titleInput, (notes, title) => ({ ...notes, title }));
bindEdit(subtitleInput, (notes, subtitle) => ({ ...notes, subtitle }));
for (const axis of axes) bindEdit(el<HTMLInputElement>('dim-' + axis),
  (notes, value) => ({ ...notes, dimensions: { ...notes.dimensions, [axis]: value } }));
el<HTMLButtonElement>('reset-dim').onclick = () => {
  history.commit({ ...history.current, dimensions: blankNotes().dimensions });
  sync();
};
unit.onchange = () => {
  if (!model || model.kind !== 'OBJ') return;
  model.unit = unit.value;
  model.unitFactor = unitChoices[unit.value] ?? null;
  syncDimensions();
  redraw();
  status(model.unit ? '已按 ' + model.unit + ' 换算外形尺寸。' : '源单位未知，可以手填标注。');
};

function finishTextEdit() {
  if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) {
    document.activeElement.blur();
  }
}
function undo() { if (cancelInteraction()) return; finishTextEdit(); history.undo(); retainSelection(); sync(); }
function redo() { if (cancelInteraction()) return; finishTextEdit(); history.redo(); retainSelection(); sync(); }
function retainSelection() {
  if (!history.current.marks.some(mark => mark.id === selected)) selected = null;
}
undoButton.onclick = undo;
undoMarkButton.onclick = undo;
redoButton.onclick = redo;
drawButton.onclick = drawPanel.onclick = () => { cancelInteraction(); drawing(!drawMode); };
selectButton.onclick = () => { cancelInteraction(); drawing(false); };
viewChoice.onchange = () => {
  renderPreview();
  redraw();
  if (!compareFrame.hidden) showBefore(true);
  captureRender();
};
styleChoice.onchange = () => { updateButtons(); renderPreview(); captureRender('切换渲染风格'); };
function updateExposure() {
  const value = exposureSlider.valueAsNumber;
  exposureOutput.textContent = value > 0 ? '+' + value : String(value);
  resetExposure.disabled = exposureSlider.disabled || value === exposureControl.default;
}
exposureSlider.oninput = () => {
  updateExposure();
  if (exposureFrame) return;
  exposureFrame = requestAnimationFrame(() => {
    exposureFrame = 0;
    if (!busy && !exportPending) renderPreview();
  });
};
exposureSlider.onchange = () => { flushPreview(); captureRender('调整曝光'); };
resetExposure.onclick = () => {
  exposureSlider.valueAsNumber = exposureControl.default;
  updateExposure();
  renderPreview();
  captureRender('重置曝光');
};
function updateLightControls() {
  lightZ.valueAsNumber=tuning.lightZ;lightY.valueAsNumber=tuning.lightY;
  el('light-z-value').textContent=tuning.lightZ+'°';el('light-y-value').textContent=tuning.lightY+'°';
  lightZ.setAttribute('aria-valuetext',tuning.lightZ+' 度，水平旋转');lightY.setAttribute('aria-valuetext',tuning.lightY+' 度，垂直旋转');
  resetLight.disabled=lightZ.disabled||(tuning.lightZ===0&&tuning.lightY===0);
}
function flushPreview() {
  if(exposureFrame){cancelAnimationFrame(exposureFrame);exposureFrame=0;}
  renderPreview();
}
for(const slider of [lightZ,lightY]) {
  slider.oninput=()=>{
    tuning={...tuning,lightZ:lightZ.valueAsNumber,lightY:lightY.valueAsNumber};
    updateLightControls();comparisonView=-1;
    if(!exposureFrame)exposureFrame=requestAnimationFrame(()=>{exposureFrame=0;if(!busy&&!exportPending)renderPreview();});
  };
  slider.onchange=()=>{flushPreview();captureRender('调整光箱方向');};
}
resetLight.onclick=()=>{tuning={...tuning,lightZ:0,lightY:0};updateLightControls();comparisonView=-1;flushPreview();captureRender('光箱归零');};
lineMode.onchange = () => {
  const mode = lineMode.value as LineMode;
  if (selected === null) { nextLineMode = mode; return; }
  history.commit({ ...history.current, marks: history.current.marks.map(m => m.id === selected ?
    { ...m, mode, b: constrainLine(m.a, m.b, mode) } : m) });
  updateButtons();
  redraw();
};
labelSide.onchange = () => {
  if (selected === null) return;
  const side = labelSide.value as LabelSide;
  history.commit({ ...history.current, marks: history.current.marks.map(m => m.id === selected ? { ...m, side } : m) });
  updateButtons();
  redraw();
};

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if (pickingPart) { assistant.cancelPicking(); return; }
    if (cancelInteraction()) return;
    if (drawMode) { drawing(false); return; }
    if (selected !== null) { selectMark(null); return; }
  }
  if (event.isComposing || !(event.ctrlKey || event.metaKey)) return;
  if (event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
  if (event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); }
});

function sheetUnitsPerPixel() {
  return SHEET_WIDTH / (overlay.getBoundingClientRect().width || SHEET_WIDTH);
}
function point(event: PointerEvent): Point {
  const rect = overlay.getBoundingClientRect();
  return { x: (event.clientX - rect.left) * SHEET_WIDTH / rect.width,
    y: (event.clientY - rect.top) * SHEET_HEIGHT / rect.height };
}
function inside(p: Point): Point {
  return {
    x: Math.min(SHEET_WIDTH - 12, Math.max(12, p.x)),
    y: Math.min(SHEET_HEIGHT - 12, Math.max(12, p.y)),
  };
}

function hitEndpoint(p: Point) {
  const mark = history.current.marks.find(m => m.id === selected);
  if (!mark) return null;
  const distance = (endpoint: Endpoint) => Math.hypot(mark[endpoint].x-p.x, mark[endpoint].y-p.y);
  const endpoint: Endpoint = distance('a') < distance('b') ? 'a' : 'b';
  return distance(endpoint) <= 10 * sheetUnitsPerPixel() ? { mark, endpoint } : null;
}
function hitMark(p: Point) {
  const tolerance = 7 * sheetUnitsPerPixel();
  return history.current.marks.slice().reverse().find(mark => {
    const label = labelBounds.get(mark.id);
    return distanceToSegment(p, mark) <= tolerance ||
      (label && p.x >= label.x && p.x <= label.x+label.w && p.y >= label.y && p.y <= label.y+label.h);
  });
}
function cancelInteraction() {
  const current = interaction;
  if (!current) return false;
  interaction = null;
  draft = null;
  if (overlay.hasPointerCapture(current.pointer)) overlay.releasePointerCapture(current.pointer);
  overlay.dataset.target = '';
  redraw();
  return true;
}
function updateDraft(p: Point) {
  if (!draft || !interaction) return;
  if (interaction.type === 'draw') {
    draft = { ...draft, b: constrainLine(draft.a, inside(p), draft.mode) };
  } else {
    const { original, endpoint, offset } = interaction;
    draft = moveEndpoint(original, endpoint, inside({ x:p.x+offset.x, y:p.y+offset.y }));
  }
}
overlay.addEventListener('pointerdown', event => {
  if (!model || event.button !== 0 || busy || interaction) return;
  finishTextEdit();
  const p = point(event);
  if (pickingPart) {
    const hit = renderer?.pickPart(p, selectedView());
    if (hit) assistant.pickPart(hit.mesh, hit.index);
    event.preventDefault();
    return;
  }
  if (drawMode) {
    const a = inside(p);
    draft = { id: markId, a, b: a, value: '', mode: nextLineMode, side: 'auto' };
    interaction = { pointer: event.pointerId, type: 'draw' };
  } else {
    const hit = hitEndpoint(p);
    if (!hit) { selectMark(hitMark(p)?.id ?? null); return; }
    const { mark, endpoint } = hit;
    draft = mark;
    interaction = { pointer: event.pointerId, type: 'edit', original: mark, endpoint,
      offset: { x: mark[endpoint].x-p.x, y: mark[endpoint].y-p.y } };
    overlay.dataset.target = 'dragging';
  }
  overlay.setPointerCapture(event.pointerId);
  event.preventDefault();
  redraw();
});
overlay.addEventListener('pointermove', event => {
  const p = point(event);
  if (interaction?.pointer !== event.pointerId) {
    if (!drawMode && !interaction) overlay.dataset.target = hitEndpoint(p) ? 'endpoint' : hitMark(p) ? 'mark' : '';
    return;
  }
  updateDraft(p);
  redraw();
});
overlay.addEventListener('pointerup', event => {
  if (!draft || interaction?.pointer !== event.pointerId) return;
  const type = interaction.type;
  updateDraft(point(event));
  const mark = draft;
  cancelInteraction();
  if (Math.hypot(mark.a.x - mark.b.x, mark.a.y - mark.b.y) < 6) return;
  if (type === 'edit') {
    history.commit({ ...history.current, marks: history.current.marks.map(m => m.id === mark.id ? mark : m) });
    updateButtons();
    redraw();
    return;
  }
  markId++;
  selected = mark.id;
  history.commit({ ...history.current, marks: [...history.current.marks, mark] });
  drawing(false);
  sync();
  const input = markList.querySelector<HTMLInputElement>('input[data-mark="' + mark.id + '"]');
  input?.focus({ preventScroll:true });
  if (window.innerWidth > 760) input?.scrollIntoView({ block:'nearest' });
});
overlay.addEventListener('lostpointercapture', event => { if (interaction?.pointer === event.pointerId) cancelInteraction(); });
overlay.addEventListener('pointercancel', event => { if (interaction?.pointer === event.pointerId) cancelInteraction(); });

function browserSource(files:File[],kind:'browser'|'drop'='browser'):ImportSource {
  return {kind,files:files.map(file=>({name:file.name,size:file.size,modified:file.lastModified}))};
}
async function importModel(files: File[],source=browserSource(files),record?:RenderRecord):Promise<boolean> {
  if (busy || pickingModel || exportPending || assistantRendering || files.length === 0) return false;
  window.clearTimeout(historyTimer);captureRender();
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  cancelInteraction();
  busy = true;
  drawing(false);
  updateButtons();
  showProgress('正在读取模型…');
  let loaded: RenderModel | null = null;
  const previous = model;
  try {
    await new Promise(resolve => window.requestAnimationFrame(() => window.setTimeout(resolve, 0)));
    loaded = await loadModel(files, showProgress);
    const modelKey=await renderModelKey(files);
    if(record&&record.modelKey!==modelKey)throw new Error('源文件内容或名称已变化，请通过「导入模型」创建新记录。');
    showProgress('正在绘制预览…');
    try { renderer ??= new SheetRenderer(); }
    catch { throw new Error('浏览器未能启用 WebGL2。请检查硬件加速，或用 Chrome / Edge 打开。'); }
    renderer.attach(loaded);
    renderer.setTuning(defaultTuning);
    renderer.preview(baseContext, previewScale, selectedView(), selectedStyle(), exposureControl.default);
    if (previous) disposeModel(previous);
    model = loaded;
    resetComparison();
    tuning = { ...defaultTuning };
    assistant.setModel(loaded);
    exposureSlider.valueAsNumber = exposureControl.default;
    updateExposure();
    updateLightControls();
    blocked = false;
    history.reset({...blankNotes(),subtitle:modelCaption(model.name)});
    selected = null;
    markId = 1;
    el('editor').hidden = false;
    el('unit-row').hidden = model.kind !== 'OBJ';
    unit.value = model.unit;
    el('name').textContent = model.name;
    el('name').title = model.name;
    el('model-type').hidden = false;
    el('model-type').textContent = model.kind;
    el('info').textContent = model.parts + ' 个渲染网格 · 已自动适配';
    status(['模型已导入。', model.unitFactor === null ? '源单位未知，可在右侧设置单位或手填标注。' : '',
      ...model.warnings].filter(Boolean).join(' '), 'success');
    sync();
    const id=renderHistory.begin(modelKey,model.name,source,record);
    if(source.kind!=='native'){
      sessionFiles.set(id,files);
      while(sessionFiles.size>18)sessionFiles.delete(sessionFiles.keys().next().value!);
    }
    if(!record)captureRender('初始渲染');
    return true;
  } catch (error) {
    if (loaded && loaded !== model) disposeModel(loaded);
    if (previous && renderer) {
      renderer.attach(previous);
      renderer.setTuning(tuning);
      renderer.setMaterialOverrides(assistant.overrides());
      try { renderPreview(); } catch { drawEmpty(baseContext, previewScale); }
    } else {
      drawEmpty(baseContext, previewScale);
    }
    blocked = true;
    const message = error instanceof Error ? error.message : String(error);
    status(message + (previous ? ' 画布保留上一模型。请重新导入后再导出。' : ''), 'error');
    return false;
  } finally {
    hideProgress();
    busy = false;
    updateButtons();
  }
}

async function finishModelSelection(files:File[],source:ImportSource,record?:RenderRecord){
  if(await importModel(files,source,record)&&record){
    try{await restoreRecordState(record);captureRender();status('已恢复「'+record.modelName+'」的最后效果。','success');}
    catch(error){status(error instanceof Error?error.message:'恢复记录失败。','error');}
  }
}
async function openModelPicker(record?:RenderRecord){
  if(!nativeImportAvailable){reselectRecord=record;filePicker.click();return;}
  pickingModel=true;updateButtons();showProgress('请选择模型及材质文件…');
  try{
    const selected=await nativeModelFiles();
    pickingModel=false;hideProgress();updateButtons();
    if(selected)await finishModelSelection(selected.files,selected.source,record);
    else status('已取消导入。');
  }catch(error){status(error instanceof Error?error.message:'模型选择失败。','error');}
  finally{pickingModel=false;hideProgress();updateButtons();}
}
openButton.onclick = () => void openModelPicker();
filePicker.addEventListener('change', () => {
  const files = Array.from(filePicker.files ?? []);
  filePicker.value = '';
  const record=reselectRecord;reselectRecord=undefined;
  void finishModelSelection(files,browserSource(files),record);
});
filePicker.addEventListener('cancel',()=>{reselectRecord=undefined;});
let dragDepth = 0;
paper.addEventListener('dragenter', event => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  dragDepth++;
  paper.dataset.drop = 'true';
});
paper.addEventListener('dragover', event => {
  if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
});
paper.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) paper.dataset.drop = 'false';
});
paper.addEventListener('drop', event => {
  event.preventDefault();
  dragDepth = 0;
  paper.dataset.drop = 'false';
  const files=Array.from(event.dataTransfer?.files??[]);
  void importModel(files,browserSource(files,'drop'));
});
window.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
window.addEventListener('drop', event => { if (event.dataTransfer?.files.length) event.preventDefault(); });

async function savePng() {
  if (!model || !renderer || busy || blocked || exportPending || assistantRendering) return;
  if(exposureFrame)flushPreview();
  const exportModel = model;
  const notes = structuredClone(history.current);
  const preset = selectedView();
  const style = selectedStyle();
  const exposure = exposureSlider.valueAsNumber;
  const sheet = document.createElement('canvas');
  sheet.width = 6000;
  sheet.height = 4000;
  exportPending = true;
  updateButtons();
  showProgress('正在准备 6000 × 4000 PNG…');
  try {
    await document.fonts.ready;
    await new Promise(resolve => window.requestAnimationFrame(() => window.setTimeout(resolve, 0)));
    const ctx = sheet.getContext('2d');
    if (!ctx) throw new Error('无法分配导出画布，请关闭其他页面后重试。');
    await renderer.renderExport(ctx, exportModel, notes, preset, style, exposure, ratio => {
      const percent = Math.round(ratio * 100);
      showProgress('正在渲染 PNG 图块…', percent, percent + '%');
    });
    showProgress('正在编码 PNG…');
    const encoded = await new Promise<Blob | null>(resolve => sheet.toBlob(resolve, 'image/png'));
    if (!encoded) throw new Error('PNG 生成失败，请重试。');
    const blob = await withPrintResolution(encoded, 300);
    captureRender('导出 PNG');
    const name = pngFileName(notes.title,notes.subtitle,exportModel.name);
    showProgress('正在保存 PNG…');
    const local = await saveLocalExport(name, blob);
    if (local.cancelled) {
      status('已取消保存。');
      return;
    }
    if (local.saved) {
      status('PNG 已保存到：' + local.path, 'success');
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    status('已生成 6000 × 4000 PNG，请查看浏览器下载。', 'success');
  } catch (error) {
    status(error instanceof Error ? error.message : '导出失败，请重试。', 'error');
  } finally {
    hideProgress();
    sheet.width = 0;
    sheet.height = 0;
    exportPending = false;
    updateButtons();
    fitPreview();
  }
}

exportButton.onclick = () => void savePng();
new ResizeObserver(fitPreview).observe(paper);
window.addEventListener('resize', fitPreview);
fitPreview();
drawEmpty(baseContext, previewScale);
updateButtons();
