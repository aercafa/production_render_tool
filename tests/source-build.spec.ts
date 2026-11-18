import {expect,test} from '@playwright/test';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

test('源码启动台识别网页过期及依赖变化，避免拉取后运行旧版',async()=>{
  const root=path.resolve('local-fixtures','source-build-'+randomUUID());
  await mkdir(path.join(root,'src'),{recursive:true});await mkdir(path.join(root,'dist'),{recursive:true});await mkdir(path.join(root,'node_modules'));
  await writeFile(path.join(root,'package.json'),JSON.stringify({version:'0.3.2'}));
  await writeFile(path.join(root,'package-lock.json'),'{}');
  await writeFile(path.join(root,'src','main.ts'),'first');await writeFile(path.join(root,'dist','index.html'),'build');
  const script=path.resolve('scripts/source-build.mjs');
  const status=(mode:string)=>spawnSync(process.execPath,[script,mode,root]).status;
  expect(status('check')).toBe(1);
  execFileSync(process.execPath,[script,'stamp',root]);
  expect(status('check')).toBe(0);expect(status('deps')).toBe(0);
  await writeFile(path.join(root,'src','main.ts'),'updated');
  expect(status('check')).toBe(1);expect(status('deps')).toBe(0);
  execFileSync(process.execPath,[script,'stamp',root]);expect(status('check')).toBe(0);
  await writeFile(path.join(root,'package-lock.json'),'{"updated":true}');
  expect(status('check')).toBe(1);expect(status('deps')).toBe(1);
});
