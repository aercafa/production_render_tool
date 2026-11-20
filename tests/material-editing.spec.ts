import { expect,test } from '@playwright/test';
import * as THREE from 'three';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import { AssistantEdits,defaultTuning,type SceneValues } from '../src/assistant-edits';
import type { RenderModel } from '../src/model';
import { rhinoMaterialAliases } from '../src/material-identity';

const scene: SceneValues={...defaultTuning,style:'premium',exposure:0};
function sharedModel() {
  const group=new THREE.Group();
  for(const [name,originalId,id]of [['左框','metal-a','metal-a'],['右框','metal-b','metal-a'],['塑料面板','plastic','plastic']]){
    const geometry=new THREE.BoxGeometry(1,1,1);geometry.computeBoundingBox();
    const material=new THREE.MeshStandardMaterial({color:'#333333',roughness:.5});
    const mesh=new THREE.Mesh(geometry,material);mesh.name=name;
    mesh.userData.workbenchBounds=geometry.boundingBox!.clone();
    mesh.userData.workbenchMaterials=[{id,originalId,name:id==='plastic'?'塑料':'金属'}];group.add(mesh);
  }
  return {group,name:'shared.3dm',kind:'3DM',size:new THREE.Vector3(3,1,1),parts:3,unit:'mm',unitFactor:1,warnings:[]} as RenderModel;
}

test('相同名称和完整参数的 Rhino 副本合并，不合并不同纹理、参数或不同名称',()=>{
  const source={id:'a',renderMaterialInstanceId:'instance-a',name:'金属',roughness:.5,textures:[{fileName:'metal.png',image:'data-a'}]};
  const result=rhinoMaterialAliases([source,{...source,id:'b',renderMaterialInstanceId:'instance-b'},
    {...source,id:'c',roughness:.2},{...source,id:'d',textures:[{fileName:'other.png',image:'data-b'}]},
    {...source,id:'e',name:'独立饰条'},{id:'f',name:''},{id:'g',name:''}]);
  expect(result.get('b')).toBe('a');
  for(const id of ['c','d','e','f','g'])expect(result.get(id)).toBe(id);
});

test('点选和 p* 旧目标统一到共用材质，撤销及旧历史不会再产生局部覆盖',()=>{
  const model=sharedModel(),edits=new AssistantEdits(model);
  expect(edits.materials.size).toBe(2);
  expect(edits.materialFor('p2')?.id).toBe('m1');
  expect(edits.materialFor('m2')?.id).toBe('m1'); // Old second Rhino definition.
  const context=edits.context('p2',scene);
  expect(context.selectedMaterial).toBe('m1');expect(context.selectedPart).toBeNull();
  expect(context.materials[0].count).toBe(2);
  const available=new Set([...context.parts,...context.materials].map(item=>item.id));
  const changes=edits.validate([{target:'p2',property:'color',value:'#335577'},
    {target:'m1',property:'color',value:'#335577'}],'m1',available,scene);
  expect(changes).toEqual([{target:'m1',property:'color',value:'#335577'}]);
  edits.apply(changes,scene);
  const [left,right,plastic]=model.group.children as THREE.Mesh[];
  expect(edits.overrides().get(left)?.get(0)?.color).toBe('#335577');
  expect(edits.overrides().get(right)?.get(0)?.color).toBe('#335577');
  expect(edits.overrides().has(plastic)).toBe(false);
  expect(edits.snapshot().map(([id])=>id)).toEqual(['m1']);
  edits.undo(scene);expect(edits.overrides().size).toBe(0);
  edits.restore([['m2',{color:'#003344'}],['p1',{roughness:.7}]],scene,scene);
  expect(edits.overrides().get(left)?.get(0)).toEqual(edits.overrides().get(right)?.get(0));
  expect(edits.overrides().get(right)?.get(0)?.roughness).toBe(.7);
  expect(()=>edits.validate([{target:'m3',property:'color',value:'#ffffff'}],'m1',new Set(['m3']),scene)).toThrow('超出所选材质');
  expect(()=>edits.validate([{target:'p1',property:'color',value:'#ffffff'},
    {target:'p2',property:'color',value:'#000000'}],'m1',available,scene)).toThrow('冲突');
});

test('大模型清单截断后仍含可编辑材质，场景大小限制不会让请求无响应',()=>{
  const model=sharedModel();
  for(let i=0;i<90;i++){
    const mesh=(model.group.children[0] as THREE.Mesh).clone();mesh.name='部件'+i;
    mesh.userData.workbenchBounds=mesh.geometry.boundingBox!.clone();
    mesh.userData.workbenchMaterials=[{id:'unique-'+i,name:'独立材质'+i}];model.group.add(mesh);
  }
  const context=new AssistantEdits(model).context('',scene);
  expect(context.requiresMaterialSelection).toBe(true);
  expect(context.materials.length).toBeGreaterThan(0);
  expect(JSON.stringify(context).length).toBeLessThanOrEqual(56000);
  expect(context.parts.every(part=>context.materials.some(material=>material.id===part.material))).toBe(true);
});

test('真实3DM的重复材质合并，AI格式修正后可整组应用和撤销',async({page},info)=>{
  const file=process.env.RENDER_SHARED_MATERIAL_3DM;
  test.skip(!file,'需要指定业务3DM路径');
  let requests=0;const contexts: any[]=[];
  const provider=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString());requests++;
    const context=JSON.parse(body.messages[1].content.slice('当前场景数据：'.length));contexts.push(context);
    res.writeHead(200,{'Content-Type':'application/json'});
    const content=requests===1?'确认后我会修改':JSON.stringify({status:'proposal',reply:'将共用金属的所有位置统一调整。',
      changes:[{target:context.selectedMaterial,property:'pattern',value:'metal_matte'},
        {target:context.selectedMaterial,property:'color',value:'#3a4045'}]});
    res.end(JSON.stringify({choices:[{message:{content}}]}));
  });
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
  try{
    await page.goto('/');await page.locator('#file').setInputFiles(file!);
    await expect(page.locator('#message')).toContainText('模型已导入',{timeout:45000});
    const scope=page.locator('#assistant-scope');
    const metals=scope.locator('option').filter({hasText:/^金属（\d+ 处）$/});
    const plastics=scope.locator('option').filter({hasText:/^塑胶（\d+ 处）$/});
    await expect(metals).toHaveCount(1);await expect(plastics).toHaveCount(1);
    const label=await metals.textContent();expect(Number(label!.match(/（(\d+)/)![1])).toBeGreaterThan(1);
    await scope.selectOption((await metals.getAttribute('value'))!);
    await page.request.put('/api/workbench/settings',{headers:{'X-Render-Workbench':'local-v1'},data:{
      assistant:{url:'http://127.0.0.1:'+(provider.address() as AddressInfo).port,model:'fixture',key:'',keepKey:false},
    }});
    await page.getByRole('button',{name:'设置',exact:true}).click();
    await page.getByRole('button',{name:'保存设置',exact:true}).click();
    await page.locator('#assistant-input').fill('把选中材质改成深灰亚光金属');await page.locator('#assistant-send').click();
    await expect(page.locator('#assistant-feedback')).toContainText('已自动修正响应格式');
    await expect(page.locator('#assistant-changes')).toContainText(label!);
    expect(requests).toBe(2);expect(contexts.at(-1).materials).toHaveLength(1);
    await page.locator('#assistant-apply').click();await expect(page.locator('#assistant-feedback')).toContainText('已应用');
    await expect(page.locator('#assistant-compare')).toBeEnabled();
    await page.screenshot({path:info.outputPath('共用材质-整组应用.png')});
    await page.locator('#assistant-undo').click();await expect(page.locator('#assistant-feedback')).toContainText('已撤销');
  }finally{provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));}
});
