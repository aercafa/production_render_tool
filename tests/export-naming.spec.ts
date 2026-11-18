import { expect,test } from '@playwright/test';
import { modelCaption,pngFileName } from '../src/export';
import { fixtureFiles } from './fixture-model';

test('导出名称按题目、辅助说明、模型名取值并兼容 Windows 文件名',()=>{
  expect(modelCaption('L29终端.3dm')).toBe('L29终端');
  expect(modelCaption('L29.V2.OBJ')).toBe('L29.V2');
  expect(pngFileName('L29','L29终端','旧模型.3dm')).toBe('L29.png');
  expect(pngFileName('  ','L29终端','旧模型.3dm')).toBe('L29终端.png');
  expect(pngFileName('最新题目','旧说明','旧模型.3dm')).toBe('最新题目.png');
  expect(pngFileName('','','L29终端.3dm')).toBe('L29终端.png');
  expect(pngFileName('L29.png','','旧模型.3dm')).toBe('L29.png');
  expect(pngFileName('L29/终端:测试','','旧模型.3dm')).toBe('L29_终端_测试.png');
  expect(pngFileName('CON','','旧模型.3dm')).toBe('_CON.png');
});

test('新导入自动填写辅助说明，PNG 使用最后编辑的题目或说明',async({page},info)=>{
  await page.goto('/');
  const files=await Promise.all(fixtureFiles().map(async file=>({
    name:file.name.endsWith('.obj')?'L29终端.obj':file.name,mimeType:'text/plain',buffer:Buffer.from(await file.arrayBuffer()),
  })));
  await page.locator('#file').setInputFiles(files);
  await expect(page.locator('#message')).toContainText('模型已导入');
  await expect(page.locator('#subtitle')).toHaveValue('L29终端');
  await page.selectOption('#unit','mm');
  const exportAs=async(name:string)=>{
    const event=page.waitForEvent('download');await page.locator('#export').click();
    const file=await event;expect(file.suggestedFilename()).toBe(name);
    await file.saveAs(info.outputPath(name));
    await expect(page.locator('#export')).toBeEnabled();
  };
  await exportAs('L29终端.png');
  await page.locator('#title').fill('旧题目');
  await page.locator('#title').fill('L29');
  await exportAs('L29.png');
  await page.locator('#title').fill('  ');
  await page.locator('#subtitle').fill('L29终端修改版');
  await exportAs('L29终端修改版.png');
  await expect(page.locator('.history-card')).toHaveCount(1);
});
