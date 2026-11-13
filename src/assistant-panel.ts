import { askAssistant, readSettings, type ChatMessage } from './local-service';
import { AssistantEdits, type Change, type SceneValues } from './assistant-edits';
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
      <label class="field"><span class="assistant-input-label">描述想要的效果</span>
        <textarea id="assistant-input" maxlength="3000" rows="3" placeholder="例如：把所选材质改成深胡桃木，纹路细一点。"></textarea></label>
      <div class="row assistant-actions"><button id="assistant-undo" type="button">撤销助手修改</button>
        <button id="assistant-send" class="primary" type="submit">发送</button></div>
    </form>
  </aside>`;

export function bindAssistant(options: {
  scene: () => SceneValues;
  render: (scene: SceneValues, edits: AssistantEdits, compare: boolean) => Promise<void>;
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
  const proposal = get('assistant-proposal');
  const changesList = get('assistant-changes');
  const setup = get('assistant-setup');
  const progress = get('assistant-progress');
  const progressLabel = get('assistant-stage');
  let edits: AssistantEdits | undefined;
  let model: RenderModel | undefined;
  let messages: ChatMessage[] = [];
  let pending: { changes: Change[]; scene: SceneValues } | undefined;
  let configFingerprint = '';
  let session = 0;
  let requesting = false;
  let ready = false;
  let locked = false;
  let processing = '';

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
    scope.disabled = !model || !!processing || locked;
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
    if (pending) { pending = undefined; message('所选材质已切换，请重新发送要应用的修改。'); update(); }
  };
  get('assistant-discard').onclick = () => {
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
    pending = undefined;
    message('');
    processing = '正在应用材质并刷新四视图…';
    update();
    try {
      await options.render(edits.apply(changes, current), edits, true);
      recordOutcome('已应用 ' + changes.length + ' 项修改。请读取最新场景参数。');
      message('已应用 ' + changes.length + ' 项修改。');
    } catch {
      try { await options.render(edits.undo(options.scene()), edits, false); } catch { /* The preview error is reported below. */ }
      message('预览刷新失败，已撤销本次修改。', true);
    } finally {
      processing = '';
      update();
    }
  }
  apply.onclick = applyPending;
  undo.onclick = async () => {
    if (!edits?.canUndo || locked || requesting) return;
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
    const context = state?.context(target, current) ?? { current, materials: [], modelLoaded: false };
    const available = new Set(context.materials.map(material => material.id));
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
    try {
      const answer = await askAssistant(conversation, context);
      if (currentSession !== session) return;
      if (answer.changes.length) {
        if (!state) throw new Error('请先导入模型，再应用材质或渲染修改。');
        if (sceneChanged(current, options.scene())) throw new Error('渲染参数已有变化，请重新发送指令。');
        const changes = state.validate(answer.changes, target, available, current);
        if (changes.length) {
          pending = { changes, scene: current };
          renderPending();
        } else {
          message('建议与当前参数一致，没有待应用的修改。');
        }
      }
      append('assistant', answer.reply);
      messages.push({ role: 'assistant', content: answer.reply });
      messages = messages.slice(-12);
    } catch (error) {
      if (currentSession === session) {
        if (!input.value) input.value = content;
        message(error instanceof Error ? error.message : String(error), true);
      }
    } finally {
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
    scope.replaceChildren(new Option('全部模型材质', ''));
    ensureMaterials();
    clearConversation();
  }

  scope.replaceChildren(new Option('导入模型后选择材质', ''));
  clearConversation();
  void refreshSettings();
  return {
    refreshSettings, setModel,
    overrides: () => edits?.overrides(),
    setLocked(value: boolean) { locked = value; update(); },
  };
}
