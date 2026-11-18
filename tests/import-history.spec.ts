import { expect,test } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { fixtureFiles } from './fixture-model';

test('原生导入记录来源，按批次更新、跨模型回查、刷新重开且取消不新增',async({page},info)=>{
  const dir=path.resolve('local-fixtures','import-history-'+randomUUID());
  const input=path.join(dir,'中文 源模型');await mkdir(input,{recursive:true});
  const sourceFiles=[];
  for(const file of fixtureFiles()){
    const name=path.join(input,file.name);await writeFile(name,Buffer.from(await file.arrayBuffer()));sourceFiles.push(name);
  }
  const second=path.join(input,'第二个模型.obj');
  await writeFile(second,await readFile(sourceFiles.find(name=>name.endsWith('.obj'))!));
  let selection=sourceFiles,chosen=0;
  const oldHome=process.env.RENDER_WORKBENCH_HOME;process.env.RENDER_WORKBENCH_HOME=path.join(dir,'service');
  let service:any;
  try{
    const module=await import(pathToFileURL(path.resolve('server/local-workbench.mjs')).href+'?fixture='+randomUUID());
    service=module.createWorkbenchService({selectModelFiles:async()=>{chosen++;return selection;}});
  }finally{if(oldHome===undefined)delete process.env.RENDER_WORKBENCH_HOME;else process.env.RENDER_WORKBENCH_HOME=oldHome;}
  const server=createServer((req,res)=>void service.handle(req,res));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const headers={'X-Render-Workbench':'local-v1'};
  try{
    await page.route('**/api/workbench/models/**',async route=>{
      const req=route.request(),suffix=new URL(req.url()).pathname.split('/api/workbench')[1]+new URL(req.url()).search;
      const response=await page.request.fetch(address+suffix,{method:req.method(),headers:{...headers,'Content-Type':'application/json'},data:req.postData()??undefined});
      await route.fulfill({response});
    });
    await page.goto('/');
    await expect(page.locator('#assistant-connection')).not.toContainText('正在读取');
    const open=page.getByRole('button',{name:'导入模型',exact:false});
    await open.click();
    await expect(page.locator('#message')).toContainText('模型已导入');
    await expect(page.locator('.history-card')).toHaveCount(1);
    const id=(await page.locator('.history-card').getAttribute('data-record'))!;
    await expect(page.locator('.history-card')).toHaveAttribute('title',new RegExp(input.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
    await expect(page.locator('.history-card time')).toHaveAttribute('datetime',/\d{4}-\d\d-\d\dT/);
    const time=await page.locator('.history-card time').getAttribute('datetime');
    await page.selectOption('#unit','mm');
    await page.selectOption('#render-style','premium');
    await page.locator('#light-z').evaluate((el:HTMLInputElement)=>{el.value='35';el.dispatchEvent(new Event('input'));el.dispatchEvent(new Event('change'));});
    await page.locator('#title').fill('第一批最终效果');
    await page.locator('#light-z').focus();
    await expect(page.locator('.history-card')).toHaveCount(1);
    await expect(page.locator('.history-card time')).toHaveAttribute('datetime',time!);
    selection=[second,...sourceFiles.filter(name=>!name.endsWith('.obj'))];
    await open.click();await expect(page.locator('#name')).toHaveText('第二个模型.obj');
    await expect(page.locator('.history-card')).toHaveCount(2);
    expect(chosen).toBe(2);
    await page.locator('[data-record="'+id+'"]').click();
    await expect(page.locator('#message')).toContainText('已恢复');
    await expect(page.locator('#name')).toHaveText('示例终端.obj');
    await expect(page.locator('#light-z')).toHaveValue('35');
    await expect(page.locator('#title')).toHaveValue('第一批最终效果');
    await expect(page.locator('.history-card')).toHaveCount(2);
    expect(chosen).toBe(2);
    await page.reload();await page.locator('[data-record="'+id+'"]').click();
    await expect(page.locator('#message')).toContainText('已恢复');
    await expect(page.locator('#light-z')).toHaveValue('35');
    await expect(page.locator('#title')).toHaveValue('第一批最终效果');
    await expect(page.locator('#unit')).toHaveValue('mm');
    await expect(page.locator('.history-card')).toHaveCount(2);
    selection=[];await open.click();await expect(page.locator('#message')).toContainText('已取消');
    await expect(page.locator('.history-card')).toHaveCount(2);
    const denied=await page.request.get(address+'/models/file?token=unknown');expect(denied.status()).toBe(403);
    const unknown=await page.request.get(address+'/models/file?path='+encodeURIComponent(sourceFiles[0]),{headers});expect(unknown.status()).toBe(404);
    const forged=await page.request.post(address+'/models/reopen',{headers,data:{id:'../../settings.json'}});expect(forged.status()).toBe(404);
    const png=page.waitForEvent('download');await page.locator('#export').click();
    await(await png).saveAs(info.outputPath('导入批次历史-恢复效果.png'));
    await expect(page.locator('.history-card')).toHaveCount(2);
    await page.screenshot({path:info.outputPath('导入批次历史.png')});
    await page.locator('#file').setInputFiles({name:'失败模型.obj',mimeType:'text/plain',buffer:Buffer.from('# no faces')});
    await expect(page.locator('#message')).toContainText('画布保留上一模型');
    await expect(page.locator('.history-card')).toHaveCount(2);
  }finally{service.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
