import { expect, test } from '@playwright/test';
import { readFile, mkdir, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { fixtureFiles } from './fixture-model';
const toolbarDraw = (page: import('@playwright/test').Page) => page.getByRole('group', { name: '标注工具' })
  .getByRole('button', { name: '绘制辅助线' });
const canvasHash = async (page: Page, selector: string) => createHash('sha256')
  .update(await page.locator(selector).evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL())).digest('hex');

async function loadFixture(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('请选择或拖入模型');
  await expect(page.getByRole('button', { name: '载入示例' })).toHaveCount(0);
  const files = await Promise.all(fixtureFiles().map(async file => ({
    name: file.name, mimeType: 'text/plain', buffer: Buffer.from(await file.arrayBuffer()),
  })));
  await page.locator('#file').setInputFiles(files);
  await expect(page.getByRole('status')).toContainText('模型已导入');
  await page.getByRole('combobox', { name: 'OBJ 源文件单位' }).selectOption('mm');
}

test('渲染助手通过兼容 API 修改颜色和程序化木纹，支持确认与撤销', async ({ page }, info) => {
  const requests: { authorization?: string; body: { messages: { role: string; content: string }[]; model: string } }[] = [];
  const apiKey = 'fixture-render-key';
  const provider = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ authorization: req.headers.authorization, body });
    const isTest = body.messages.length === 1;
    const context = isTest ? null : JSON.parse(body.messages[1].content.slice('当前场景数据：'.length));
    const base = context?.materials.find((material: { name: string }) => material.name === 'base');
    const frame = context?.materials.find((material: { name: string }) => material.name === 'frame');
    const last = body.messages.at(-1).content;
    const request = typeof last === 'string' ? last : last[0].text;
    const localFrame = context?.parts.find((part: { name: string }) => part.name === '立柱');
    const changes = request === '改一个不存在的部件'
      ? [{ target:'bad-id', property:'color', value:'#ff0000' }]
      : request === '再降低阴影'
      ? [{ target:'scene', property:'shadow', value:.2 }]
      : request === '只把立柱改成绿色'
      ? [{ target:localFrame?.id ?? 'bad-id', property:'color', value:'#00bc00' }]
      : request === '共用框体改红'
      ? [{ target:frame?.id ?? 'bad-id', property:'color', value:'#e30000' }]
      : request === '改成亚光浅橡木，加细节'
      ? [{ target:base?.id ?? 'bad-id', property:'pattern', value:'oak' },
        { target:base?.id ?? 'bad-id', property:'grainDetail', value:.8 }]
      : request === '再加细节'
      ? [{ target:base?.id ?? 'bad-id', property:'grainDetail', value:.95 }]
      : request.startsWith('试用预设 ')
      ? [{ target:base?.id ?? 'bad-id', property:'pattern', value:request.split(' ')[1] }]
      : [{ target:base?.id ?? 'bad-id', property:'color', value:'#d40000' },
        { target:'scene', property:'style', value:'premium' },
        { target:'scene', property:'exposure', value:2 }];
    if (request === '把底座改成红色') await new Promise(resolve => setTimeout(resolve, 250));
    res.writeHead(req.url === '/v1/chat/completions' && req.headers.authorization === 'Bearer ' + apiKey ? 200 : 401,
      { 'Content-Type':'application/json' });
    const proposal = JSON.stringify({ reply:'这是本轮建议。', changes });
    const content = isTest ? 'OK' : request === '只把立柱改成绿色' ? '这是一条说明。\n```json\n' + proposal + '\n```' : proposal;
    res.end(JSON.stringify({ choices:[{ message:{ content } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  try {
    await loadFixture(page);
    await page.getByRole('button',{name:'API 设置',exact:true}).click();
    const settings = page.getByRole('dialog', { name:'工作台设置' });
    await settings.getByLabel('API URL').fill('http://127.0.0.1:' + (provider.address() as AddressInfo).port + '/v1');
    await settings.getByLabel('模型名').fill('fixture-model');
    await settings.getByLabel('API Key', { exact:true }).fill(apiKey);
    await settings.getByRole('button',{name:'测试连接'}).click();
    await expect(settings).toContainText('连接成功');
    await settings.getByRole('button',{name:'保存设置'}).click();
    await expect(settings).toBeHidden();
    const publicSettings = await page.request.get('/api/workbench/settings', { headers:{ 'X-Render-Workbench':'local-v1' } });
    expect(await publicSettings.text()).not.toContain(apiKey);
    const input = page.getByRole('textbox',{name:'描述想要的效果'});
    const send = page.getByRole('button',{name:'发送',exact:true});
    const preview = () => canvasHash(page, '#base');
    const before = await preview();
    const view = page.getByRole('combobox', { name:'主视角' });
    await view.selectOption({label:'后左低轴测'});
    const beforeFromRear = await preview();
    expect(beforeFromRear).not.toBe(before);
    await view.selectOption({label:'前右低轴测'});
    const scope = page.getByRole('combobox',{name:'要修改的范围'});
    await expect(scope.locator('option', { hasText:'frame（2 处）' })).toHaveCount(1);
    await scope.selectOption({label:'base（1 处）'});
    await input.fill('把底座改成红色');
    await send.click();
    await expect(page.locator('#assistant-progress')).toContainText('正在分析材质');
    await expect(page.locator('#assistant-changes')).toContainText('base（1 处）');
    await expect(page.locator('#assistant-changes')).toContainText('#d40000');
    expect(await preview()).toBe(before);
    const apply = page.getByRole('button',{name:'应用修改'});
    await apply.click();
    await expect(page.getByRole('slider',{name:'曝光'})).toHaveValue('2');
    const compare = page.getByRole('button',{name:'按住对比修改前'});
    await expect(compare).toBeEnabled();
    await compare.focus();
    await page.keyboard.down('Space');
    await expect(compare).toHaveAttribute('aria-pressed','true');
    expect(await canvasHash(page, '#compare-frame')).toBe(before);
    await page.keyboard.up('Space');
    await expect(compare).toHaveAttribute('aria-pressed','false');
    await view.selectOption({label:'后左低轴测'});
    const renderUndo = page.getByRole('button', {name:'撤销渲染'});
    await expect(renderUndo).toBeEnabled();
    await expect(compare).toBeEnabled();
    expect(await preview()).not.toBe(beforeFromRear);
    const box = (await compare.boundingBox())!;
    await page.mouse.move(box.x + box.width/2, box.y + box.height/2);
    await page.mouse.down();
    await expect(page.getByText('修改前',{exact:true})).toBeVisible();
    expect(await canvasHash(page, '#compare-frame')).toBe(beforeFromRear);
    await page.mouse.move(box.x - 30, box.y + box.height/2);
    await page.mouse.up();
    await expect(page.getByText('修改前',{exact:true})).toBeHidden();
    await view.selectOption({label:'前右低轴测'});
    expect(await preview()).not.toBe(before);
    const download = page.waitForEvent('download');
    await page.getByRole('button',{name:'导出 PNG'}).click();
    const editedPng = await readFile((await (await download).path())!);
    const redPixels = await page.evaluate(async encoded => {
      const bitmap = await createImageBitmap(await (await fetch('data:image/png;base64,' + encoded)).blob());
      const canvas = document.createElement('canvas');
      canvas.width = 600;
      canvas.height = 400;
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap,0,0,600,400);
      bitmap.close();
      const data = context.getImageData(0,260,600,112).data;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 80 && data[i] > data[i+1]*2 && data[i] > data[i+2]*2) count++;
      }
      return count;
    }, editedPng.toString('base64'));
    expect(redPixels).toBeGreaterThan(300);
    await input.fill('再降低阴影');
    await send.click();
    await expect(page.locator('#assistant-changes')).toContainText('阴影强度');
    await apply.click();
    expect(requests.at(-1)?.body.messages.some(message => message.content === '把底座改成红色')).toBe(true);
    expect(requests.at(-1)?.body.messages[1].content).toContain('"color":"#d40000"');
    const undo = page.getByRole('button',{name:'撤销助手修改'});
    await undo.click();
    await view.selectOption({label:'后左低轴测'});
    await renderUndo.click();
    await expect(page.locator('#assistant-feedback')).toContainText('已撤销');
    await expect(view).toHaveValue('3');
    await expect(page.getByRole('slider',{name:'曝光'})).toHaveValue('0');
    expect(await preview()).toBe(beforeFromRear);
    await view.selectOption({label:'前右低轴测'});
    expect(await preview()).toBe(before);
    await input.fill('改一个不存在的部件');
    await send.click();
    await expect(page.locator('#assistant-feedback')).toContainText('超出所选材质');
    await expect(apply).toBeHidden();
    expect(await preview()).toBe(before);

    const shaderErrors: string[] = [];
    page.on('console', entry => {
      if (entry.type() === 'error' && /shader|GL_INVALID|compile/i.test(entry.text())) shaderErrors.push(entry.text());
    });
    await input.fill('改成亚光浅橡木，加细节');
    await send.click();
    await expect(page.locator('#assistant-changes')).toContainText('浅橡木 · 哑光');
    await expect(page.locator('#assistant-changes')).toContainText('木纹细节');
    expect(await preview()).toBe(before);
    const sent = requests.length;
    await input.fill('确认修改');
    await send.click();
    await expect(page.locator('#assistant-feedback')).toContainText('已应用 2 项');
    expect(requests).toHaveLength(sent);
    const woodPreview = await preview();
    expect(woodPreview).not.toBe(before);
    await input.fill('再加细节');
    await send.click();
    await expect(page.locator('#assistant-changes')).toContainText('0.8 → 0.95');
    expect(requests.at(-1)?.body.messages[0].content).toContain('不能用单纯棕色或增加 AO 代替');
    expect(requests.at(-1)?.body.messages[1].content).toContain('"pattern":"oak"');
    await apply.click();
    await expect(page.locator('#assistant-feedback')).toContainText('已应用');
    expect(await preview()).not.toBe(woodPreview);
    await undo.click();
    await expect(page.locator('#assistant-feedback')).toContainText('已撤销');
    expect(await preview()).toBe(woodPreview);
    const woodDownload = page.waitForEvent('download');
    await page.getByRole('button',{name:'导出 PNG'}).click();
    const woodPng = await woodDownload;
    await woodPng.saveAs(info.outputPath('程序化浅橡木.png'));
    const wood = await readFile((await woodPng.path())!);
    const grainVariance = await page.evaluate(async encoded => {
      const bitmap = await createImageBitmap(await (await fetch('data:image/png;base64,' + encoded)).blob());
      const canvas = document.createElement('canvas');
      canvas.width = 600;
      canvas.height = 400;
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap,0,0,600,400);
      bitmap.close();
      // Isolate warm wood pixels on the flat bottom face in the front elevation.
      const data = context.getImageData(300,320,145,20).data;
      const reds = [];
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > data[i+2] + 20 && data[i] < 245) reds.push(data[i]);
      }
      return { count:reds.length, range:reds.length ? Math.max(...reds) - Math.min(...reds) : 0 };
    }, wood.toString('base64'));
    expect(grainVariance.count).toBeGreaterThan(80);
    expect(grainVariance.range).toBeGreaterThan(8);
    expect(shaderErrors).toEqual([]);
    await undo.click();
    await expect(page.locator('#assistant-feedback')).toContainText('已撤销');
    expect(await preview()).toBe(before);
    const variants = new Set<string>();
    for (const preset of ['walnut','metal_matte','metal_polished','plastic','rubber','engineered_stone','glass','screen','emissive']) {
      await input.fill('试用预设 ' + preset);
      await send.click();
      await expect(apply).toBeVisible();
      await apply.click();
      await expect(page.locator('#assistant-feedback')).toContainText('已应用');
      const rendered = await preview();
      expect(rendered).not.toBe(before);
      variants.add(rendered);
    }
    expect(variants.size).toBe(9);
    expect(shaderErrors).toEqual([]);
    expect(requests.at(-1)?.body.messages[0].content).toContain('"transmission":1,"ior":1.5');
    expect(requests.at(-1)?.body.messages[1].content).toContain('"pattern":"screen"');
    await scope.selectOption({label:'frame（2 处）'});
    await input.fill('共用框体改红');
    await send.click();
    await expect(page.locator('#assistant-changes')).toContainText('frame（2 处）');
    await apply.click();
    await expect(page.locator('#assistant-feedback')).toContainText('已应用');
    const framePixels = await page.locator('#base').evaluate((canvas: HTMLCanvasElement) => {
      const ctx = canvas.getContext('2d')!;
      const scale = canvas.width/1200;
      const pixels = ctx.getImageData(Math.round(700*scale), Math.round(416*scale),
        Math.round(90*scale), Math.round(220*scale)).data;
      const reds = [0, 0];
      const width = Math.round(90*scale);
      for (let i = 0; i < pixels.length; i+=4) {
        if (pixels[i] > 2*pixels[i+1] && pixels[i] > 2*pixels[i+2] && pixels[i] > 65) {
          reds[Math.floor(i/4/width) < 72*scale ? 0 : 1]++;
        }
      }
      return reds;
    });
    expect(framePixels[0]).toBeGreaterThan(10);
    expect(framePixels[1]).toBeGreaterThan(10);
    await scope.selectOption('');
    await page.getByRole('button',{name:'在图上选部件'}).click();
    const paper = (await page.locator('#overlay').boundingBox())!;
    await page.mouse.click(paper.x + paper.width * 744/1200, paper.y + paper.height * 590/800);
    await expect(page.locator('#assistant-feedback')).toContainText('已选中：立柱');
    await page.getByLabel('随本轮发送预览图（需视觉模型）').check();
    const cabinetPixels = () => page.locator('#base').evaluate((canvas: HTMLCanvasElement) => {
      const ctx = canvas.getContext('2d')!;
      return [ [709,450], [744,590] ].map(([x,y]) => Array.from(ctx.getImageData(
        Math.round(x*canvas.width/1200),Math.round(y*canvas.height/800),1,1).data));
    });
    const [housingBefore, columnBefore] = await cabinetPixels();
    await input.fill('只把立柱改成绿色');
    await send.click();
    await expect(page.locator('#assistant-changes')).toContainText('立柱（1 处）');
    await input.fill('确认');
    await send.click();
    await expect(page.locator('#assistant-feedback')).toContainText('已应用');
    const [housingAfter, columnAfter] = await cabinetPixels();
    expect(housingAfter).toEqual(housingBefore);
    expect(columnAfter).not.toEqual(columnBefore);
    expect(columnAfter[1]).toBeGreaterThan(columnAfter[0]);
    expect(JSON.stringify(requests.at(-1)?.body.messages.at(-1)?.content)).toContain('data:image/jpeg;base64,');
  } finally {
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
  }
});

test('合成产品：四视图、尺寸替换、拉线、撤回与 6000×4000 下载', async ({ page }, info) => {
  const external: string[] = [];
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:4181/')) external.push(request.url());
  });
  await loadFixture(page);
  await expect(page.locator('#info')).toContainText('7 个渲染网格');
  await expect(page.getByRole('textbox', { name: '总宽标注' })).toHaveAttribute('placeholder', '742 mm');
  await expect(page.getByRole('textbox', { name: '总深标注' })).toHaveAttribute('placeholder', '320 mm');
  await expect(page.getByRole('textbox', { name: '总高标注' })).toHaveAttribute('placeholder', '1050 mm');
  const views = await page.locator('#base').evaluate((canvas: HTMLCanvasElement) => {
    const ctx = canvas.getContext('2d')!;
    const k = canvas.width / 1200;
    return [[34,124,520,575],[589,134,311,241],[589,400,311,271],[931,400,231,271]].map(([x,y,w,h]) => {
      const pixels = ctx.getImageData(x*k,y*k,w*k,h*k).data;
      let nonBackground = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 205) nonBackground++;
      return nonBackground;
    });
  });
  expect(views.every(n => n > 500)).toBe(true);
  const width = page.getByRole('textbox', { name: '总宽标注' });
  await width.fill('750 mm');
  await width.press('Tab');
  await expect(page.locator('#source-width')).toHaveText('已替换');
  await expect(page.locator('#source-width')).toHaveAttribute('title', '网格范围换算：742 mm');
  await page.getByRole('button', { name: '恢复实测' }).click();
  await expect(width).toHaveValue('');
  await page.getByRole('textbox', { name: '题目' }).fill('工作台验收样张');
  await toolbarDraw(page).click();
  const rect = (await page.locator('#overlay').boundingBox())!;
  const x = rect.x + rect.width * .25, y = rect.y + rect.height * .79;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + rect.width * .12, y + rect.height * .12, { steps: 5 });
  await page.mouse.up();
  const local = page.getByRole('textbox', { name: '局部尺寸 1' });
  await expect(local).toBeFocused();
  await local.fill('局部 120 mm');
  await local.press('Tab');
  await page.getByRole('button', { name: '撤回', exact: true }).click();
  await expect(local).toHaveValue('');
  await page.getByRole('button', { name: '撤回', exact: true }).click();
  await expect(local).toHaveCount(0);
  await page.getByRole('button', { name: '重做' }).click();
  await page.getByRole('button', { name: '重做' }).click();
  await expect(local).toHaveValue('局部 120 mm');
  await page.screenshot({ path: info.outputPath('workbench.png') });
  const wait = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 PNG' }).click();
  await expect(page.getByRole('progressbar')).toBeVisible();
  const download = await wait;
  await expect(page.getByRole('progressbar')).toBeHidden();
  expect(download.suggestedFilename()).toBe('工作台验收样张.png');
  const output = await readFile((await download.path())!);
  expect(output.subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a');
  expect([output.readUInt32BE(16), output.readUInt32BE(20)]).toEqual([6000, 4000]);
  expect(output.toString('ascii', 37, 41)).toBe('pHYs');
  expect(output.readUInt32BE(41)).toBe(11811);
  expect(output.length).toBeGreaterThan(40000);
  await download.saveAs(info.outputPath('export.png'));
  expect(external).toEqual([]);
});

test('默认正交吸附，两端箭头对称，Ctrl+Z 可撤回', async ({ page }) => {
  await loadFixture(page);
  const mode = page.getByRole('combobox', { name: '拉线方向' });
  await expect(mode).toHaveValue('orthogonal');
  await expect(mode.locator('option')).toHaveText(['正交自动', '自由']);
  const canvas = page.locator('#overlay');
  const rect = (await canvas.boundingBox())!;
  async function drag(x: number, y: number, dx: number, dy: number) {
    await page.getByRole('complementary').getByRole('button', { name: '绘制辅助线' }).click();
    await expect(toolbarDraw(page)).toHaveAttribute('aria-pressed', 'true');
    await page.mouse.move(rect.x + rect.width * x, rect.y + rect.height * y);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width * (x+dx), rect.y + rect.height * (y+dy), { steps: 5 });
    await page.mouse.up();
  }
  await drag(.08, .17, .10, .20);
  await expect(page.getByRole('textbox', { name: '局部尺寸 1' })).toBeFocused();
  await page.keyboard.press('Escape'); // Inspect the exported arrow geometry without selection handles.
  const pixels = await canvas.evaluate((c: HTMLCanvasElement) => {
    const x0 = Math.floor(c.width * .05), y0 = Math.floor(c.height * .15);
    const w = Math.floor(c.width * .20), h = Math.floor(c.height * .24);
    const rgba = c.getContext('2d')!.getImageData(x0, y0, w, h).data;
    let minX = w, maxX = 0, minY = h, maxY = 0;
    const rowSizes: number[] = [];
    for (let y = 0; y < h; y++) {
      let count = 0;
      for (let x = 0; x < w; x++) {
        if (rgba[(y*w+x)*4+3] < 70) continue;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y); count++;
      }
      rowSizes.push(count);
    }
    const top = Math.max(...rowSizes.slice(minY, minY+9));
    const bottom = Math.max(...rowSizes.slice(maxY-8, maxY+1));
    return { width: maxX - minX, height: maxY - minY, top, bottom };
  });
  expect(pixels.width).toBeGreaterThan(12); // the two perpendicular extension lines
  expect(pixels.width).toBeLessThan(26);
  expect(pixels.height).toBeGreaterThan(85);
  expect(pixels.top).toBeGreaterThanOrEqual(2);
  expect(pixels.bottom).toBeGreaterThanOrEqual(2);
  expect(Math.abs(pixels.top - pixels.bottom)).toBeLessThanOrEqual(1);
  await page.keyboard.press('Control+z');
  await expect(page.getByRole('textbox', { name: '局部尺寸 1' })).toHaveCount(0);
  await drag(.08, .17, .15, .02);
  await page.keyboard.press('Escape');
  const horizontal = await canvas.evaluate((c: HTMLCanvasElement) => {
    const w = Math.floor(c.width * .30), h = Math.floor(c.height * .30);
    const data = c.getContext('2d')!.getImageData(0, 0, w, h).data;
    let minY = h, maxY = 0, minX = w, maxX = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 35) {
      const x = ((i-3)/4) % w, y = Math.floor((i-3)/4 / w);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    return { dx: maxX-minX, dy: maxY-minY };
  });
  expect(horizontal.dx).toBeGreaterThan(100);
  expect(horizontal.dy).toBeGreaterThan(10);
  expect(horizontal.dy).toBeLessThan(26);
  await page.getByRole('button', { name: '撤回标注' }).click();
  await expect(page.getByRole('textbox', { name: '局部尺寸 1' })).toHaveCount(0);
});

test('曝光同步到四视图和 PNG，灰白模与标注不受影响', async ({ page }) => {
  await loadFixture(page);
  const style = page.getByRole('combobox', { name:'渲染风格' });
  await style.selectOption('premium');
  const slider = page.getByRole('slider', { name:'曝光' });
  await expect(slider).toHaveAttribute('min','-10');
  await expect(slider).toHaveAttribute('max','10');
  await expect(slider).toHaveValue('0');
  const points = [[380,365],[743,198],[743,521],[1045,521],[10,10]];
  const pixels = () => page.locator('#base').evaluate((node: HTMLCanvasElement, positions) => {
    const context = node.getContext('2d')!;
    const scale = node.width / 1200;
    return positions.map(([x,y]) => Array.from(context.getImageData(x*scale,y*scale,1,1).data));
  }, points);
  const normal = await pixels();
  const dimensions = await page.locator('#overlay').evaluate((node: HTMLCanvasElement) => node.toDataURL());
  await slider.fill('-10');
  await expect.poll(async () => (await pixels())[2][0]).toBeLessThan(normal[2][0] - 8);
  const dark = await pixels();
  await slider.fill('10');
  await expect.poll(async () => (await pixels())[2][0]).toBeGreaterThan(normal[2][0] + 8);
  const bright = await pixels();
  expect(dark[4]).toEqual(normal[4]);
  expect(bright[4]).toEqual(normal[4]);
  expect(await page.locator('#overlay').evaluate((node: HTMLCanvasElement) => node.toDataURL())).toBe(dimensions);

  await style.selectOption('clay');
  await expect(slider).toBeDisabled();
  await style.selectOption('premium');
  await expect(slider).toHaveValue('10');
  await page.getByRole('button', { name:'重置曝光' }).click();
  await expect(slider).toHaveValue('0');
  expect(await pixels()).toEqual(normal);
  await slider.fill('-10');
  const pending = page.waitForEvent('download');
  await page.getByRole('button',{ name:'导出 PNG' }).click();
  const data = await readFile((await (await pending).path())!);
  const exported = await page.evaluate(async ({ image, positions }) => {
    const bitmap = await createImageBitmap(await (await fetch('data:image/png;base64,' + image)).blob());
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d')!;
    const scale = bitmap.width / 1200;
    const samples = positions.map(([x,y]) => {
      context.drawImage(bitmap,x*scale,y*scale,1,1,0,0,1,1);
      return Array.from(context.getImageData(0,0,1,1).data);
    });
    bitmap.close();
    return samples;
  }, { image:data.toString('base64'), positions:points });
  expect(Math.abs(exported[2][0] - dark[2][0])).toBeLessThan(5);
  expect(exported[4]).toEqual(normal[4]);
});

test('六档主视角只改变左图，玻璃着色可编译', async ({ page }) => {
  const shaderErrors: string[] = [];
  page.on('console', message => { if (/Shader Error|VALIDATE_STATUS|GL_INVALID_OPERATION/.test(message.text())) shaderErrors.push(message.text()); });
  await loadFixture(page);
  const view = page.getByRole('combobox', { name: '主视角' });
  await expect(view.locator('option')).toHaveText([
    '前右低轴测', '前左低轴测', '后右低轴测', '后左低轴测', '底部前右低轴测', '底部前左低轴测',
  ]);
  const fingerprints = () => page.locator('#base').evaluate((c: HTMLCanvasElement) => {
    const ctx = c.getContext('2d')!;
    return [[0, Math.floor(c.width * .47)], [Math.floor(c.width * .47), c.width]].map(([a,b]) => {
      const rgba = ctx.getImageData(a, 0, b-a, c.height).data;
      let hash = 2166136261;
      for (let i = 0; i < rgba.length; i += 4) hash = Math.imul(hash ^ (rgba[i] | rgba[i+1] << 8 | rgba[i+2] << 16), 16777619);
      return hash;
    });
  });
  const [left, right] = await fingerprints();
  await view.selectOption({ label: '后左低轴测' });
  const [changed, same] = await fingerprints();
  expect(changed).not.toEqual(left);
  expect(same).toEqual(right);
  await view.selectOption({ label: '底部前左低轴测' });
  const [bottom, stillSame] = await fingerprints();
  expect(bottom).not.toEqual(changed);
  expect(stillSame).toEqual(right);
  expect(shaderErrors).toEqual([]);
});

test('画布选择、拖动端点及文字避让，且右栏滚动不影响预览和导出', async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 680 });
  await loadFixture(page);
  const canvas = page.locator('#overlay');
  const rect = (await canvas.boundingBox())!;
  const xy = (x: number, y: number) => [rect.x+rect.width*x/1200, rect.y+rect.height*y/800] as const;
  async function drag(a: [number,number], b: [number,number]) {
    await page.mouse.move(...xy(...a));
    await page.mouse.down();
    await page.mouse.move(...xy(...b), { steps: 5 });
    await page.mouse.up();
  }
  const exportButton = page.getByRole('button', { name: '导出 PNG' });
  await expect(page.locator('.panel-footer').getByRole('button', { name: '导出 PNG' })).toBeVisible();
  const exportRect = (await exportButton.boundingBox())!;
  expect(exportRect.y + exportRect.height).toBeLessThanOrEqual(680);
  expect(rect.y + rect.height).toBeLessThanOrEqual(680);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(680);

  await toolbarDraw(page).click();
  await drag([647,225], [654,284]);
  const local = page.getByRole('textbox', { name: '局部尺寸 1' });
  await local.fill('120 mm');
  await local.press('Tab');
  await page.mouse.click(...xy(580,180));
  await expect(page.getByRole('combobox', { name: '文字位置' })).toBeDisabled();
  await page.mouse.click(...xy(647,250));
  await expect(page.getByRole('button', { name: '选中辅助线 1' })).toHaveAttribute('aria-pressed', 'true');
  const labelSide = page.getByRole('combobox', { name: '文字位置' });
  await expect(labelSide).toHaveValue('auto');

  const textRegion = () => canvas.evaluate((c: HTMLCanvasElement) => {
    const k=c.width/1200;
    const x0=Math.floor(565*k), y0=Math.floor(185*k), w=Math.floor(365*k), h=Math.floor(150*k);
    const data=c.getContext('2d')!.getImageData(x0,y0,w,h).data;
    let min=Infinity, max=-Infinity, overlaps=0;
    for(let i=0;i<data.length;i+=4) {
      if (data[i+3]<125 || Math.abs(data[i]-44)+Math.abs(data[i+1]-55)+Math.abs(data[i+2]-65)>12) continue;
      const x=(x0+i/4%w)/k, y=(y0+Math.floor(i/4/w))/k;
      min=Math.min(min,x); max=Math.max(max,x);
      if(x>660 && x<829 && y>219 && y<289) overlaps++;
    }
    return {min,max,overlaps};
  });
  const automatic = await textRegion();
  expect(automatic.min).toBeGreaterThan(565);
  expect(automatic.max).toBeLessThan(647);
  expect(automatic.overlaps).toBe(0);
  await labelSide.selectOption('far');
  const movedLabel = await textRegion();
  expect(movedLabel.min).toBeGreaterThan(647);
  expect(movedLabel.max).toBeGreaterThan(movedLabel.min);
  expect(movedLabel.overlaps).toBe(0);
  await labelSide.selectOption('auto');

  const before = await canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL());
  await drag([647,225], [705,156]);
  expect(await canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL())).not.toBe(before);
  const changed = await canvas.evaluate((c: HTMLCanvasElement) => {
    const k = c.width / 1200;
    const ctx = c.getContext('2d')!;
    const near = (x: number) => ctx.getImageData(Math.round(x*k)-3, Math.round(156*k)-3, 7, 7).data.some(
      (value, i) => i%4===3 && value>120);
    return [near(647), near(705)];
  });
  expect(changed).toEqual([true,false]); // The orthogonal endpoint moved on its original axis.
  await page.keyboard.press('Control+z');
  expect(await canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL())).toBe(before);
  await page.getByRole('combobox', { name: '拉线方向' }).selectOption('free');
  await drag([647,225], [620,156]);
  const freeEndpoint = await canvas.evaluate((c: HTMLCanvasElement) => {
    const k = c.width / 1200;
    const pixels = c.getContext('2d')!.getImageData(Math.round(620*k)-3, Math.round(156*k)-3, 7, 7).data;
    return pixels.some((value, i) => i%4===3 && value>120);
  });
  expect(freeEndpoint).toBe(true);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  expect(await canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL())).toBe(before);

  await page.locator('.panel-content').evaluate(element => { element.scrollTop = element.scrollHeight; });
  expect(await exportButton.boundingBox()).toEqual(exportRect);
  expect(await canvas.boundingBox()).toEqual(rect);
  await page.screenshot({ path: info.outputPath('fit-and-edit.png') });
});

test('同一 OBJ 内的无命名深色薄面板产生柔和反光', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('请选择或拖入模型');
  const obj = [
    'mtllib panel.mtl', 'o assembly',
    'v -300 -160 0','v 300 -160 0','v 300 160 0','v -300 160 0',
    'v -300 -160 650','v 300 -160 650','v 300 160 650','v -300 160 650',
    'v -265 -145 653','v 265 -145 653','v 265 145 770','v -265 145 770',
    'usemtl part_a','f 4 3 2 1','f 5 6 7 8','f 1 2 6 5','f 2 3 7 6','f 3 4 8 7','f 4 1 5 8',
    'usemtl part_b','f 9 10 11 12',
  ].join('\n');
  const mtl = ['newmtl part_a','Kd 0.4 0.42 0.45','newmtl part_b','Kd 0 0 0'].join('\n');
  await page.locator('#file').setInputFiles([
    { name: 'panel.obj', mimeType: 'text/plain', buffer: Buffer.from(obj) },
    { name: 'panel.mtl', mimeType: 'text/plain', buffer: Buffer.from(mtl) },
  ]);
  await expect(page.getByRole('status')).toContainText('模型已导入');
  const range = await page.locator('#base').evaluate((canvas: HTMLCanvasElement) => {
    const k = canvas.width / 1200;
    const ctx = canvas.getContext('2d')!;
    const strip = ctx.getImageData(Math.round(683*k), Math.round(254*k), Math.round(120*k), 1).data;
    const luminance = [];
    for (let i = 0; i < strip.length; i += 4) luminance.push(.21*strip[i] + .72*strip[i+1] + .07*strip[i+2]);
    return { min: Math.min(...luminance), max: Math.max(...luminance) };
  });
  expect(range.max).toBeLessThan(105);
  expect(range.max - range.min).toBeGreaterThan(12);
});

test('共面材质接缝可见，高保真辉光只出现在有发光材质的位置', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('console', m => { if (/Shader Error|GL_INVALID_OPERATION|FRAMEBUFFER_INCOMPLETE/.test(m.text())) errors.push(m.text()); });
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('请选择或拖入模型');
  const obj = [
    'mtllib seam.mtl','o panel',
    'v -300 0 0','v 0 0 0','v 300 0 0','v -300 0 400','v 0 0 400','v 300 0 400',
    'usemtl a','f 1 2 5 4','usemtl b','f 2 3 6 5',
    'o emitter','v -38 -1 172','v 38 -1 172','v 38 -1 228','v -38 -1 228','usemtl glow','f 7 8 9 10',
  ].join('\n');
  const mtl = ['newmtl a','Kd 0.37 0.37 0.37','newmtl b','Kd 0.37 0.37 0.37',
    'newmtl glow','Kd 0.02 0.05 0.08','Ke 0.1 0.8 1'].join('\n');
  await page.locator('#file').setInputFiles([
    { name:'seam.obj',mimeType:'text/plain',buffer:Buffer.from(obj) },
    { name:'seam.mtl',mimeType:'text/plain',buffer:Buffer.from(mtl) },
  ]);
  await expect(page.getByRole('status')).toContainText('模型已导入');
  const style = page.getByRole('combobox', { name:'渲染风格' });
  await style.selectOption('clay');
  const sample = (points: number[][]) => page.locator('#base').evaluate((c:HTMLCanvasElement, coords) => {
    const k=c.width/1200;
    return coords.map(([x,y]) => Array.from(c.getContext('2d')!.getImageData(Math.round(x*k),Math.round(y*k),1,1).data));
  },points);
  const row = await sample([[723,470],[743,470],[744,470],[745,470],[746,470],[765,470]]);
  expect(Math.min(...row.slice(1,-1).map(px=>px[0]))).toBeLessThan(Math.min(row[0][0],row.at(-1)![0])-7);
  const glowPoints = [[744,535],[765,535],[791,535]];
  await style.selectOption('studio');
  const basic = await sample(glowPoints);
  await style.selectOption('premium');
  const enhanced = await sample(glowPoints);
  expect(enhanced[0][2]).toBeGreaterThan(enhanced[0][0]+25);
  expect(enhanced[1][2]-enhanced[1][0]).toBeGreaterThan(enhanced[2][2]-enhanced[2][0]+4);
  expect(enhanced[1][2]-enhanced[1][0]).toBeGreaterThan(basic[1][2]-basic[1][0]+4);
  expect(errors).toEqual([]);
  await page.screenshot({ path:info.outputPath('glow.png') });
});

test('32 寸原件给出缺网格处置指引，渲染副本可切换风格', async ({ page }, info) => {
  const original = process.env.RENDER_32_ORIGINAL;
  const mesh = process.env.RENDER_32_MESH;
  test.skip(!original || !mesh,'通过环境变量指定 32 寸原件和渲染副本');
  await page.route(/\/api\/workbench\/mesh\?/, route => route.fulfill({ status:503, json:{ error:'本机未找到 Rhino 8' } }));
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('请选择或拖入模型');
  await page.locator('#file').setInputFiles(original!);
  await expect(page.getByRole('status')).toContainText('16/16 个曲面缺少有效显示网格');
  await expect(page.getByRole('status')).toContainText('保存小文件');
  await expect(page.getByRole('button',{name:'导出 PNG'})).toBeDisabled();
  await page.locator('#file').setInputFiles(mesh!);
  await expect(page.getByRole('status')).toContainText('模型已导入',{timeout:25000});
  await expect(page.locator('#info')).toContainText('7 个渲染网格');
  await expect(page.locator('#dim-width')).toHaveAttribute('placeholder','773.9 mm');
  await expect(page.locator('#dim-depth')).toHaveAttribute('placeholder','435.88 mm');
  await expect(page.locator('#dim-height')).toHaveAttribute('placeholder','1050 mm');
  await page.locator('#title').fill('32寸立式终端');
  for (const mode of ['studio','clay','premium']) {
    await page.getByRole('combobox',{name:'渲染风格'}).selectOption(mode);
    const pending = page.waitForEvent('download');
    await page.getByRole('button',{name:'导出 PNG'}).click();
    const download = await pending;
    const data = await readFile((await download.path())!);
    expect([data.readUInt32BE(16),data.readUInt32BE(20)]).toEqual([6000,4000]);
    await download.saveAs(info.outputPath(mode+'.png'));
  }
});

test('OBJ 导入默认不猜单位，失败时保留旧画布并停用导出', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('请选择或拖入模型');
  const file = page.locator('#file');
  await file.setInputFiles({ name: 'triangle.obj', mimeType: 'text/plain',
    buffer: Buffer.from('o sample\nv 0 0 0\nv 2 0 0\nv 0 1 1\nf 1 2 3\n') });
  await expect(page.getByRole('status')).toContainText('源单位未知');
  const width = page.getByRole('textbox', { name: '总宽标注' });
  await expect(width).toHaveAttribute('placeholder', '手填标注');
  await page.getByRole('combobox', { name: 'OBJ 源文件单位' }).selectOption('cm');
  await expect(width).toHaveAttribute('placeholder', '20 mm');
  await file.setInputFiles({ name: 'broken.obj', mimeType: 'text/plain', buffer: Buffer.from('# no faces') });
  await expect(page.getByRole('status')).toContainText('没有可渲染的网格面');
  await expect(page.locator('#name')).toHaveText('triangle.obj');
  await expect(page.getByRole('button', { name: '导出 PNG' })).toBeDisabled();
});

test('回字形业务 3DM：原件报出缺网格，完整网格副本可导出', async ({ page }, info) => {
  const original = process.env.RENDER_MISSING_3DM;
  const complete = process.env.RENDER_COMPLETE_3DM;
  test.skip(!original || !complete, '通过环境变量指定本地验收模型');
  await page.route(/\/api\/workbench\/mesh\?/, route => route.fulfill({ status:503, json:{ error:'本机未找到 Rhino 8' } }));
  const external: string[] = [];
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:4181/')) external.push(request.url());
  });
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('请选择或拖入模型');
  const file = page.locator('#file');
  await file.setInputFiles(original!);
  await expect(page.getByRole('status')).toContainText('16/16 个曲面缺少有效显示网格', { timeout: 25000 });
  await expect(page.getByRole('button', { name: '导出 PNG' })).toBeDisabled();
  await file.setInputFiles(complete!);
  await expect(page.getByRole('status')).toContainText('模型已导入', { timeout: 25000 });
  await expect(page.locator('#info')).toContainText('5 个渲染网格');
  await expect(page.getByRole('textbox', { name: '总宽标注' })).toHaveAttribute('placeholder', '742 mm');
  await expect(page.getByRole('textbox', { name: '总深标注' })).toHaveAttribute('placeholder', '320.96 mm');
  await expect(page.getByRole('textbox', { name: '总高标注' })).toHaveAttribute('placeholder', '1050 mm');
  await page.getByRole('textbox', { name: '题目' }).fill('21.5寸回字形信息带');
  await page.getByRole('textbox', { name: '辅助说明' }).fill('同源网格副本 · 外形尺寸预览');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 PNG' }).click();
  const download = await pending;
  const output = await readFile((await download.path())!);
  expect([output.readUInt32BE(16), output.readUInt32BE(20)]).toEqual([6000, 4000]);
  await download.saveAs(info.outputPath('reference-export.png'));
  await page.screenshot({ path: info.outputPath('reference-workbench.png') });
  const style = page.getByRole('combobox', { name: '渲染风格' });
  await expect(style).toHaveValue('studio');
  const errors: string[] = [];
  page.on('console', message => { if (/Shader Error|GL_INVALID_OPERATION|FRAMEBUFFER_INCOMPLETE/.test(message.text())) errors.push(message.text()); });
  await style.selectOption('clay');
  const stats = await page.locator('#base').evaluate((canvas: HTMLCanvasElement) => {
    const k = canvas.width/1200;
    const ctx = canvas.getContext('2d')!;
    const data = ctx.getImageData(34*k,124*k,520*k,575*k).data;
    let outline = 0, crease = 0, face = 0, saturated = 0;
    for(let i=0;i<data.length;i+=4) {
      const [r,g,b] = [data[i],data[i+1],data[i+2]];
      if (r < 130) outline++;
      if (r >= 130 && r < 206) crease++;
      if (r >= 225 && r < 252) face++;
      if (Math.max(r,g,b)-Math.min(r,g,b)>2) saturated++;
    }
    return { outline, crease, face, saturated, background: Array.from(ctx.getImageData(0,0,1,1).data) };
  });
  expect(stats.outline).toBeGreaterThan(50);
  expect(stats.crease).toBeGreaterThan(30);
  expect(stats.face).toBeGreaterThan(2000);
  expect(stats.saturated).toBe(0);
  expect(stats.background).toEqual([255,255,255,255]);
  const clayPending = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 PNG' }).click();
  const clay = await clayPending;
  const clayOutput = await readFile((await clay.path())!);
  expect([clayOutput.readUInt32BE(16),clayOutput.readUInt32BE(20)]).toEqual([6000,4000]);
  expect(clayOutput.equals(output)).toBe(false);
  await clay.saveAs(info.outputPath('clay-export.png'));
  await page.screenshot({ path: info.outputPath('clay-workbench.png') });
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test('战车操作台原始 3DM 自动生成网格，缓存到期及清理，PNG 保存到指定目录', async ({ page }, info) => {
  const source = process.env.RENDER_CHARIOT_3DM;
  test.skip(!source, '通过 RENDER_CHARIOT_3DM 指定原件，本机需有 Rhino 8');
  test.setTimeout(180000);
  const fileHash = async () => createHash('sha256').update(await readFile(source!)).digest('hex');
  const originalHash = await fileHash();
  const cache = info.outputPath('本机缓存目录');
  const output = info.outputPath('成图');
  await Promise.all([mkdir(cache, { recursive:true }), mkdir(output, { recursive:true })]);
  await page.goto('/');
  const status = page.locator('#status');
  await expect(status).toContainText('请选择或拖入模型');
  const settings = page.getByRole('dialog', { name:'工作台设置' });
  const openSettings = () => page.getByRole('button', { name:'设置', exact:true }).click();
  await openSettings();
  await expect(settings).toContainText('已找到本机 Rhino 8');
  await settings.getByLabel('缓存位置').fill(cache);
  await settings.getByLabel('默认图片导出位置').fill(output);
  await settings.getByRole('button', { name:'保存设置' }).click();
  await expect(settings).not.toBeVisible();
  const file = page.locator('#file');
  const converted = page.waitForResponse(async response =>
    response.url().includes('/mesh/progress?') && (await response.json()).stage === 'meshing');
  await file.setInputFiles(source!);
  await expect(page.getByRole('progressbar')).toBeVisible();
  const progress = await (await converted).json();
  expect(progress.total).toBe(125);
  expect(progress.completed).toBeGreaterThanOrEqual(0);
  await expect(status).toContainText('已自动生成显示网格', { timeout:100000 });
  await expect(page.getByRole('progressbar')).toBeHidden();
  await expect(page.locator('#info')).toContainText('125 个渲染网格');
  await expect(page.locator('#dim-width')).toHaveAttribute('placeholder','2200 mm');
  await expect(page.locator('#dim-depth')).toHaveAttribute('placeholder','855 mm');
  await expect(page.locator('#dim-height')).toHaveAttribute('placeholder','2100 mm');
  const cacheDir = path.join(cache,'RenderWorkbench-MeshCache');
  const meshes = async () => (await readdir(cacheDir)).filter(name => name.endsWith('.3dm'));
  const entries = await meshes();
  expect(entries).toHaveLength(1);
  const cached = path.join(cacheDir,entries[0]);
  const initialMtime = (await stat(cached)).mtimeMs;
  await file.setInputFiles(source!);
  await expect(status).toContainText('已复用 24 小时网格缓存', { timeout:30000 });
  expect((await stat(cached)).mtimeMs).toBe(initialMtime);
  await page.locator('#title').fill('西周车战 · 战车融合操作台');
  await page.getByRole('combobox',{name:'渲染风格'}).selectOption('premium');
  await page.getByRole('button', { name:'导出 PNG' }).click();
  await expect(status).toContainText('PNG 已保存到：', { timeout:45000 });
  const image = path.join(output,'西周车战 · 战车融合操作台.png');
  const png = await readFile(image);
  expect([png.readUInt32BE(16),png.readUInt32BE(20)]).toEqual([6000,4000]);
  await page.screenshot({ path:info.outputPath('战车工作台.png') });
  const now = Date.now()/1000;
  await utimes(cached,now-25*3600,now-25*3600);
  await openSettings();
  await expect(settings.locator('#cache-stats')).toContainText('0 份');
  expect(await meshes()).toHaveLength(0);
  await expect(settings.getByLabel('默认图片导出位置')).toHaveValue(output);
  await settings.getByRole('button', { name:'取消' }).click();
  await file.setInputFiles(source!);
  await expect(status).toContainText('已自动生成显示网格', { timeout:100000 });
  const unrelated = path.join(cacheDir,'keep.txt');
  await writeFile(unrelated,'保留');
  await openSettings();
  await expect(settings.locator('#cache-stats')).toContainText('1 份');
  await settings.getByRole('button',{name:'清理网格缓存'}).click();
  await expect(settings).toContainText('已清理 1 份网格缓存');
  expect(await meshes()).toHaveLength(0);
  expect(await readFile(unrelated,'utf8')).toBe('保留');
  expect((await readFile(image)).equals(png)).toBe(true);
  expect(await fileHash()).toBe(originalHash);
  await settings.getByRole('button', { name:'取消' }).click();
  await expect(page.getByRole('button', {name:'导出 PNG'})).toBeEnabled();
});
