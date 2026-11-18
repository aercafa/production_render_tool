import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve(process.argv[3]||process.cwd());
const mode=process.argv[2];
const stamp=path.join(root,'dist','source-build.json');
const hashFile=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fingerprint(){
  const files=[];
  const walk=folder=>{for(const item of fs.readdirSync(folder,{withFileTypes:true})){
    const file=path.join(folder,item.name);if(item.isDirectory())walk(file);else if(item.isFile())files.push(file);
  }};
  for(const folder of ['src','server','scripts'])if(fs.existsSync(path.join(root,folder)))walk(path.join(root,folder));
  for(const file of ['index.html','package.json','package-lock.json','tsconfig.json','vite.config.mjs']){
    const source=path.join(root,file);if(fs.existsSync(source))files.push(source);
  }
  const hash=createHash('sha256');
  for(const file of files.sort())hash.update(path.relative(root,file).replaceAll('\\','/')).update('\0').update(fs.readFileSync(file)).update('\0');
  return hash.digest('hex');
}
try{
  const previous=fs.existsSync(stamp)?JSON.parse(fs.readFileSync(stamp,'utf8')):null;
  const lockHash=hashFile(path.join(root,'package-lock.json'));
  if(mode==='stamp'){
    fs.mkdirSync(path.dirname(stamp),{recursive:true});
    fs.writeFileSync(stamp,JSON.stringify({version:JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version,inputs:fingerprint(),lockHash},null,2));
  }else if(mode==='check'){
    process.exit(fs.existsSync(path.join(root,'dist/index.html'))&&previous?.inputs===fingerprint()?0:1);
  }else if(mode==='deps'){
    process.exit(fs.existsSync(path.join(root,'node_modules'))&&previous?.lockHash===lockHash?0:1);
  }else throw Error('Usage: node scripts/source-build.mjs stamp|check|deps');
}catch(error){
  if(mode==='stamp')console.error(error.message);
  process.exitCode=1;
}
