import { askAssistant, readSettings, reportAssistantOutcome, type ChatMessage } from './local-service';
import { AssistantEdits, type Change, type MaterialSnapshot, type SceneValues } from './assistant-edits';
import type { RenderModel } from './model';

export const assistantMarkup = `
  <aside id="assistant-panel" class="assistant-panel" aria-labelledby="assistant-heading">
    <header class="assistant-head"><h2 id="assistant-heading">渲染助手</h2>
      <div class="row"><button id="assistant-new" class="link" type="button">新对话</button>
        <button id="assistant-close" class="link" type="button" aria-label="收起渲染助手">收起</button></div></header>
    <div id="assistant-setup" class="assistant-setup">
      <p id="assistant-connection" class="hint">正在读取语言模型设置…</p>
      <button id="assistant-open-settings" class="quiet" type="button">API 设置</button>
    </div>
    <div id="assistant-chat" class="assistant-chat" role="log" aria-label="渲染对话"></div>
    <div id="assistant-progress" class="assistant-progress" aria-live="polite" hidden>
      <span class="assistant-spinner" aria-hidden="true"></span><span id="assistant-stage"></span>
    </div>
    <div id="assistant-proposal" class="assistant-proposal" hidden>
      <h3>待应用的修改</h3><ul id="assistant-changes"></ul>
      <div class="row"><button id="assistant-apply" class="primary" type="button">应用修改</button>
        <button id="assistant-discard" type="button">放弃</button></div>
    </div>
    <form id="assistant-form" class="assistant-form">
      <p id="assistant-feedback" class="hint" aria-live="polite"></p>
      <label class="field">要修改的模型材质<select id="assistant-scope"></select></label>
      <p class="hint">编辑整组材质；图上点选后，共用该材质的部件一起更新。</p>
      <button id="assistant-pick" type="button" aria-pressed="false">在图上选部件</button>
      <label class="assistant-vision"><input id="assistant-vision" type="checkbox"> 随本轮发送预览图（需视觉模型）</label>
      <label class="field"><span class="assistant-input-label">描述想要的效果</span>
        <textarea id="assistant-input" maxlength="3000" rows="3" placeholder="例如：把所选材质改成深胡桃木，纹路细一点。"></textarea></label>
      <div class="row assistant-actions"><button id="assistant-undo" type="button">撤销助手修改</button>
        <button id="assistant-send" class="primary" type="submit">发送</button></div>
    </form>
  </aside>`;

export function bindAssistant(options: {
  scene: () => SceneValues;
  render: (scene: SceneValues, edits: AssistantEdits, compare: boolean) => Promise<void>;
  picking: (enabled: boolean) => void;
  previewImage: () => string;
}) {
  const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const chat = get('assistant-chat');
  const feedback = get('assistant-feedback');
  const input = get<HTMLTextAreaElement>('assistant-input');
  const scope = get<HTMLSelectElement>('assistant-scope');
  const form = get<HTMLFormElement>('assistant-form');
  const send = get<HTMLButtonElement>('assistant-send');
  const apply = get<HTMLButtonElement>('assistant-apply');
  const undo = get<HTMLButtonElement>('assistant-undo');
  const pick = get<HTMLButtonElement>('assistant-pick');
  const vision = get<HTMLInputElement>('assistant-vision');
  const proposal = get('assistant-proposal');
  const changesList = get('assistant-changes');
  const setup = get('assistant-setup');
  const progress = get('assistant-progress');
  const progressLabel = get('assistant-stage');
  let edits: AssistantEdits | undefined;
  let model: RenderModel | undefined;
  let messages: ChatMessage[] = [];
  let pending: { changes: Change[]; scene: SceneValues; requestId?: string } | undefined;
  let configFingerprint = '';
  let session = 0;
  let requesting = false;
  let ready = false;
  let locked = false;
  let processing = '';
  let picking = false;

  function setPicking(value: boolean) {
    picking = value;
    pick.setAttribute('aria-pressed', String(value));
    options.picking(value);
  }

  function message(text: string, error = false) {
    feedback.textContent = text;
    feedback.dataset.error = String(error);
  }
  function append(role: ChatMessage['role'], content: string) {
    const p = document.createElement('p');
    p.dataset.role = role;
    p.textContent = content;
    chat.append(p);
    while (chat.childElementCount > 40) chat.firstElementChild?.remove();
    chat.scrollTop = chat.scrollHeight;
  }
  function update() {
    send.disabled = !ready || !!processing || locked || !input.value.trim();
    apply.disabled = locked || !!processing;
    undo.disabled = locked || !!processing || !edits?.canUndo;
    get<HTMLButtonElement>('render-undo').disabled = undo.disabled;
    scope.disabled = !model || !!processing || locked;
    pick.disabled = scope.disabled;
    vision.disabled = scope.disabled;
    if (pick.disabled && picking) setPicking(false);
    get<HTMLButtonElement>('assistant-new').disabled = !!processing && !requesting;
    input.disabled = !ready;
    send.textContent = requesting ? '等待回复…' : '发送';
    proposal.hidden = !pending;
    progress.hidden = !processing;
    progressLabel.textContent = processing;
  }
  function clearConversation() {
    session++;
    pending = undefined;
    requesting = false;
    processing = '';
    messages = [];
    input.value = '';
    chat.replaceChildren();
    append('assistant', '说说你想调整的材质或画面。也可以先问我有哪些可调参数。');
    message('');
    update();
  }
  function sceneChanged(a: SceneValues, b: SceneValues) {
    return Object.keys(a).some(key => a[key as keyof SceneValues] !== b[key as keyof SceneValues]);
  }
  function ensureMaterials() {
    if (model && !edits) {
      edits = new AssistantEdits(model);
      for (const material of edits.materials.values()) {
        const name = material.name + '（' + material.slots.length + ' 处）';
        scope.append(new Option(name, material.id));
      }
    }
    return edits;
  }
  function renderPending() {
    changesList.replaceChildren();
    if (!pending || !edits) return;
    for (const change of pending.changes) {
      const row = document.createElement('li');
      row.textContent = edits.describe(change, pending.scene, pending.changes);
      changesList.append(row);
    }
  }
  function recordOutcome(content: string) {
    messages.push({ role: 'assistant', content: '工作台结果：' + content });
  }
  const openSettings = () => get<HTMLButtonElement>('settings-button').click();
  get('assistant-open-settings').onclick = openSettings;
  get('assistant-new').onclick = clearConversation;
  get('assistant-close').onclick = () => get<HTMLButtonElement>('assistant-toggle').click();
  input.oninput = update;
  input.onkeydown = event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing && !send.disabled) form.requestSubmit();
  };
  scope.onchange = () => {
    setPicking(false);
    if (pending) { pending = undefined; message('编辑范围已切换，请重新发送要应用的修改。'); update(); }
  };
  pick.onclick = () => {
    setPicking(!picking);
    if (picking) message('请在预览中点击要编辑的表面。');
  };
  get('assistant-discard').onclick = () => {
    reportAssistantOutcome(pending?.requestId,'discarded');
    pending = undefined;
    recordOutcome('用户已放弃待应用建议。');
    message('已放弃建议。');
    update();
  };
  async function applyPending() {
    if (!pending || !edits || locked) return;
    const current = options.scene();
    if (sceneChanged(pending.scene, current)) {
      pending = undefined;
      message('渲染参数已有变化，请重新发送指令。', true);
      update();
      return;
    }
    const changes = pending.changes;
    const requestId=pending.requestId;
    pending = undefined;
    message('');
    processing = '正在应用材质并刷新四视图…';
    update();
    try {
      await options.render(edits.apply(changes, current), edits, true);
      reportAssistantOutcome(requestId,'applied',changes.length);
      recordOutcome('已应用 ' + changes.length + ' 项修改。请读取最新场景参数。');
      message('已应用 ' + changes.length + ' 项修改。');
    } catch {
      reportAssistantOutcome(requestId,'render_failed');
      try { await options.render(edits.undo(options.scene()), edits, false); } catch { /* The preview error is reported below. */ }
      message('预览刷新失败，已撤销本次修改。', true);
    } finally {
      processing = '';
      update();
    }
  }
  apply.onclick = applyPending;
  undo.onclick = get<HTMLButtonElement>('render-undo').onclick = async () => {
    if (undo.disabled || !edits) return;
    pending = undefined;
    message('');
    processing = '正在恢复材质…';
    update();
    try {
      await options.render(edits.undo(options.scene()), edits, false);
      recordOutcome('已撤销上一次助手修改。');
      message('已撤销上一次助手修改。');
    } catch { message('已撤销参数，但预览刷新失败。', true); }
    finally { processing = ''; update(); }
  };
  form.onsubmit = async event => {
    event.preventDefault();
    if (send.disabled) return;
    const content = input.value.trim();
    if (/^(确认修改|确认应用|应用修改|应用建议|按此应用|确认)[。！!\s]*$/.test(content)) {
      append('user', content);
      input.value = '';
      if (pending) await applyPending();
      else message('当前没有待应用的修改。请先描述想改的效果。');
      update();
      return;
    }
    const current = options.scene();
    const state = ensureMaterials();
    const target = scope.value;
    const context = state?.context(target, current) ?? { current, materials: [], parts: [], modelLoaded: false };
    const available = new Set([...context.materials, ...context.parts].map(item => item.id));
    const includePreview = vision.checked && !!model;
    vision.checked = false;
    const currentSession = session;
    requesting = true;
    processing = '正在分析材质与修改要求…';
    pending = undefined;
    input.value = '';
    append('user', content);
    messages.push({ role: 'user', content });
    const conversation = messages.slice(-12);
    if (conversation[0].role === 'assistant') conversation.shift();
    message('');
    update();
    const waiting=window.setTimeout(()=>{
      if(currentSession===session&&requesting){processing='正在等待模型返回并校验修改，请稍候…';update();}
    },12000);
    let requestId: string|undefined;
    try {
      const answer = await askAssistant(conversation, context, includePreview ? options.previewImage() : undefined);
      if (currentSession !== session) return;
      requestId=answer.requestId;
      append('assistant', answer.reply);
      messages.push({ role: 'assistant', content: answer.reply });
      if (answer.changes.length) {
        if (!state) throw new Error('请先导入模型，再应用材质或渲染修改。');
        if (sceneChanged(current, options.scene())) throw new Error('渲染参数已有变化，请重新发送指令。');
        const changes = state.validate(answer.changes, target, available, current);
        if (changes.length) {
          pending = { changes, scene: current, requestId };
          renderPending();
          reportAssistantOutcome(requestId,'validated',changes.length);
          message((answer.repaired?'已自动修正响应格式。':'')+'已校验 '+changes.length+' 项修改，请点击“应用修改”。');
        } else {
          reportAssistantOutcome(requestId,'no_difference');
          recordOutcome('建议参数与当前实际值一致，没有应用任何修改。后续请依据最新场景给出有差异的参数。');
          message('建议与当前参数一致，没有待应用的修改。');
        }
      }
      if (!answer.changes.length && !pending) message(answer.status==='clarification'
        ? '需要明确目标材质，请根据回复在图上点选后重试。'
        : answer.status==='no_change' ? '当前参数已满足本轮建议，没有修改。' : '已回复。本轮为说明，没有修改材质。');
      messages = messages.slice(-12);
    } catch (error) {
      if (currentSession === session) {
        reportAssistantOutcome(requestId,'invalid_change');
        recordOutcome('本轮未应用：'+(error instanceof Error?error.message:String(error)));
        if (!input.value) input.value = content;
        message(error instanceof Error ? error.message : String(error), true);
      }
    } finally {
      window.clearTimeout(waiting);
      if (currentSession === session) { requesting = false; processing = ''; update(); }
    }
  };

  async function refreshSettings() {
    try {
      const config = (await readSettings()).assistant;
      const fingerprint = JSON.stringify([config.url, config.model]);
      if (configFingerprint && fingerprint !== configFingerprint) clearConversation();
      configFingerprint = fingerprint;
      ready = !!(config.url && config.model);
      get('assistant-connection').textContent = ready
        ? config.model + ' · ' + new URL(config.url).host : '配置语言模型后开始对话。';
    } catch {
      ready = false;
      get('assistant-connection').textContent = '无法读取语言模型设置。';
    }
    setup.dataset.ready = String(ready);
    update();
  }
  function setModel(next: RenderModel) {
    model = next;
    edits = undefined;
    scope.replaceChildren(new Option('自动定位模型材质', ''));
    ensureMaterials();
    clearConversation();
  }

  scope.replaceChildren(new Option('导入模型后选择材质', ''));
  clearConversation();
  void refreshSettings();
  return {
    refreshSettings, setModel,
    cancelPicking: () => setPicking(false),
    pickPart(mesh: Parameters<AssistantEdits['partAt']>[0], index: number) {
      const part = edits?.partAt(mesh,index);
      if (!part) { message('这里没有可编辑的表面，请重新点选。'); return; }
      const material = edits!.materialFor(part.id)!;
      scope.value = material.id;
      scope.dispatchEvent(new Event('change'));
      message('已选中：' + part.name + ' → ' + material.name + '（' + material.slots.length + ' 处将一起修改）');
    },
    overrides: () => edits?.overrides(),
    snapshot: () => ensureMaterials()?.snapshot() ?? [],
    async restore(snapshot: MaterialSnapshot, next: SceneValues) {
      const state=ensureMaterials();
      if (!state || locked || processing) throw new Error('请等待当前处理完成后再恢复记录。');
      pending=undefined;
      processing='正在恢复历史材质与灯光…';update();
      try {
        const scene=state.restore(snapshot,options.scene(),next);
        try { await options.render(scene,state,true); }
        catch(error){try{await options.render(state.undo(options.scene()),state,false);}catch{/* Report the original rendering error. */}throw error;}
        recordOutcome('用户已恢复一条渲染历史。请读取最新材质与灯光参数。');
        message('已恢复渲染历史，可撤销或继续调整。');
      } finally { processing='';update(); }
    },
    setLocked(value: boolean) { locked = value; update(); },
  };
}
