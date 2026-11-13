import { chooseFolder, clearCache, readSettings, testAssistant, writeSettings, type LocalSettings } from './local-service';

export const settingsMarkup = `
  <dialog id="settings" class="settings" aria-labelledby="settings-title">
    <form id="settings-form">
      <header class="settings-head">
        <div><h2 id="settings-title">工作台设置</h2><p>管理本机网格缓存和图片保存位置。</p></div>
        <button id="settings-close" class="quiet" type="button" aria-label="关闭设置">✕</button>
      </header>
      <fieldset id="settings-fields" disabled>
        <div class="settings-section">
          <label class="field" for="cache-location"><strong>缓存位置</strong></label>
          <div class="folder-field field"><input id="cache-location" type="text" placeholder="留空使用默认位置">
            <button id="browse-cache" type="button" aria-label="选择缓存文件夹">浏览…</button></div>
          <p class="hint" id="cache-detail"></p>
          <div class="row cache-actions"><span id="cache-stats"></span>
            <button id="clear-cache" type="button">清理网格缓存</button></div>
        </div>
        <div class="settings-section">
          <label class="field" for="export-location"><strong>默认图片导出位置</strong></label>
          <div class="folder-field field"><input id="export-location" type="text" placeholder="留空使用浏览器下载">
            <button id="browse-export" type="button" aria-label="选择图片导出文件夹">浏览…</button></div>
          <p class="hint">设置后直接保存 PNG。同名图片自动加编号。</p>
        </div>
        <div class="settings-section input-group">
          <strong>语言模型</strong>
          <label class="field">API URL<input id="assistant-url" type="url" maxlength="1000" placeholder="https://api.deepseek.com" spellcheck="false"></label>
          <label class="field">模型名<input id="assistant-model" maxlength="160" placeholder="按服务商填写模型 ID" spellcheck="false"></label>
          <label class="field">API Key<input id="assistant-key" type="password" maxlength="2048" autocomplete="new-password"></label>
          <div class="row cache-actions"><button id="assistant-test" type="button">测试连接</button>
            <label id="assistant-clear-label" hidden><input type="checkbox" id="assistant-clear-key"> 清除已保存的 Key</label></div>
          <p class="hint">支持 Chat Completions 兼容接口。本机服务可留空 Key。发送时服务商会收到对话及部件名和参数。</p>
        </div>
      </fieldset>
      <p id="settings-rhino" class="hint settings-rhino"></p>
      <p id="settings-feedback" class="settings-feedback" aria-live="polite"></p>
      <footer class="settings-footer">
        <button id="settings-cancel" type="button">取消</button>
        <button id="settings-save" class="primary" type="submit" disabled>保存设置</button>
      </footer>
    </form>
  </dialog>`;

export function bindSettings(onSaved: () => void) {
  const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const dialog = get<HTMLDialogElement>('settings');
  const fields = get<HTMLFieldSetElement>('settings-fields');
  const save = get<HTMLButtonElement>('settings-save');
  const cache = get<HTMLInputElement>('cache-location');
  const output = get<HTMLInputElement>('export-location');
  const feedback = get('settings-feedback');
  const open = get<HTMLButtonElement>('settings-button');
  const url = get<HTMLInputElement>('assistant-url');
  const model = get<HTMLInputElement>('assistant-model');
  const key = get<HTMLInputElement>('assistant-key');
  const clearKey = get<HTMLInputElement>('assistant-clear-key');
  const assistantValues = () => ({ url: url.value.trim(), model: model.value.trim(),
    key: key.value.trim(), keepKey: !clearKey.checked });
  let working = false;
  function message(text: string, error = false) {
    feedback.textContent = text;
    feedback.dataset.error = String(error);
  }
  function show(s: LocalSettings, fill: boolean) {
    if (fill) {
      cache.value = s.cacheLocation;
      output.value = s.exportLocation;
      url.value = s.assistant.url;
      model.value = s.assistant.model;
      key.value = '';
      key.placeholder = s.assistant.hasKey ? '已保存，留空保留' : '填写服务商提供的密钥';
      clearKey.checked = false;
      get('assistant-clear-label').hidden = !s.assistant.hasKey;
    }
    output.placeholder = s.nativeSave ? '留空时询问保存位置' : '留空使用浏览器下载';
    get('cache-detail').textContent = '每份缓存保留 ' + s.hours + ' 小时。当前目录：' + s.cacheFolder;
    get('cache-stats').textContent = s.cache
      ? s.cache.count + ' 份 · ' + new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(s.cache.bytes / 1048576) + ' MB'
      : '暂无法读取缓存统计';
    get('settings-rhino').textContent = s.rhinoAvailable ? '已找到本机 Rhino 8，可自动处理缺网格的 3DM。'
      : '未找到本机 Rhino 8。仍可导入已有网格的 3DM 或 OBJ。';
  }
  function setWorking(value: boolean, usable = true) {
    working = value;
    fields.disabled = save.disabled = value || !usable;
  }
  function report(error: unknown) { message(error instanceof Error ? error.message : String(error), true); }
  open.onclick = async () => {
    if (working) return;
    dialog.showModal();
    message('正在读取本机设置…');
    setWorking(true);
    let usable = false;
    try { show(await readSettings(), true); usable = true; message(''); }
    catch (error) { report(error); }
    finally { setWorking(false, usable); }
  };
  const close = () => { if (!working) dialog.close(); };
  dialog.addEventListener('close', () => { key.value = ''; });
  get('settings-close').onclick = close;
  get('settings-cancel').onclick = close;
  dialog.addEventListener('cancel', event => { if (working) event.preventDefault(); });
  for (const [kind, input] of [['cache', cache], ['export', output]] as const) {
    get('browse-' + kind).onclick = async () => {
      setWorking(true);
      message('请在 Windows 窗口中选择文件夹…');
      try {
        const { folder } = await chooseFolder(kind);
        if (folder) input.value = folder;
        message('');
      } catch (error) { report(error); }
      finally { setWorking(false); }
    };
  }
  get('clear-cache').onclick = async () => {
    setWorking(true);
    try {
      const stats = await clearCache();
      show(await readSettings(), false);
      message('已清理 ' + stats.removed + ' 份网格缓存。' +
        (stats.unavailable ? '有 ' + stats.unavailable + ' 个旧目录暂不可访问。' : ''));
    } catch (error) { report(error); }
    finally { setWorking(false); }
  };
  get('assistant-test').onclick = async () => {
    if (!url.reportValidity()) return;
    const config = assistantValues();
    setWorking(true);
    message('正在测试连接…');
    try {
      await testAssistant(config);
      message('连接成功。保存设置后即可对话。');
    } catch (error) { report(error); }
    finally { setWorking(false); }
  };
  get<HTMLFormElement>('settings-form').onsubmit = async event => {
    event.preventDefault();
    if (working || fields.disabled) return;
    setWorking(true);
    try {
      await writeSettings(cache.value.trim(), output.value.trim(), assistantValues());
      dialog.close();
      onSaved();
    } catch (error) { report(error); }
    finally { setWorking(false); }
  };
}
