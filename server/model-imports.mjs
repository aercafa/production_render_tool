import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

const extensions = new Set(['.obj','.3dm','.mtl','.png','.jpg','.jpeg','.webp','.gif']);
const fail = (message,status=400) => Object.assign(new Error(message),{status});

/** Only files explicitly selected in the native picker can be reopened or streamed. */
export function createModelImports(stateHome,selectFiles) {
  const registry=path.join(stateHome,'model-imports.json');
  const grants=new Map();
  async function read() {
    try { const items=JSON.parse(await fs.readFile(registry,'utf8'));return Array.isArray(items)?items:[]; }
    catch(error){if(error.code==='ENOENT')return [];throw fail('无法读取模型来源记录。',500);}
  }
  async function grant(entry) {
    const files=[];
    for(const name of entry.paths){
      let info;
      try{info=await fs.stat(name);}catch{throw fail('历史源文件已移动或不存在：'+path.basename(name),404);}
      if(!info.isFile()||info.size>1024**3)throw fail('源文件不是可导入文件，或超过 1 GiB：'+path.basename(name),413);
      const token=randomUUID();grants.set(token,{file:name,expires:Date.now()+10*60*1000});
      files.push({name:path.basename(name),path:name,size:info.size,modified:info.mtimeMs,token});
    }
    for(const[token,value]of grants)if(value.expires<Date.now())grants.delete(token);
    while(grants.size>512)grants.delete(grants.keys().next().value);
    return {id:entry.id,files};
  }
  return {
    async pick() {
      const selected=await selectFiles();
      if(!selected?.length)return {cancelled:true};
      if(selected.length>64)throw fail('一次最多选择 64 个模型与资源文件。');
      const paths=[];
      for(const name of selected){
        if(typeof name!=='string'||!path.isAbsolute(name)||!extensions.has(path.extname(name).toLowerCase()))throw fail('请选择 OBJ、3DM 及对应材质、贴图文件。');
        paths.push(await fs.realpath(name));
      }
      const entry={id:randomUUID(),paths:[...new Set(paths)],at:Date.now()};
      const result=await grant(entry);
      const entries=[entry,...await read()].slice(0,64);
      await fs.mkdir(stateHome,{recursive:true});
      const temp=path.join(stateHome,'model-imports-'+randomUUID()+'.tmp');
      try{await fs.writeFile(temp,JSON.stringify(entries),{flag:'wx'});await fs.rename(temp,registry);}
      finally{await fs.unlink(temp).catch(()=>{});}
      return result;
    },
    async reopen(id) {
      const entry=(await read()).find(item=>item.id===id);
      if(!entry)throw fail('没有找到这次导入的来源，请重新选择源文件。',404);
      return grant(entry);
    },
    async stream(token,res) {
      const entry=grants.get(token);
      if(!entry||entry.expires<Date.now())throw fail('文件读取凭证已失效，请重新导入。',404);
      let info;
      try{info=await fs.stat(entry.file);}catch{throw fail('源文件已移动或不可读。',404);}
      if(!info.isFile()||info.size>1024**3)throw fail('源文件超出导入范围。',413);
      res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':info.size,'Cache-Control':'no-store'});
      await pipeline(createReadStream(entry.file),res);
    },
  };
}
