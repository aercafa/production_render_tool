import { expect, test } from '@playwright/test';
import * as THREE from 'three';
import { premiumMaterial, premiumSurface, styleRenderMesh } from '../src/studio';

test('高保真按表层材质分类，区分缎面、磨砂、亚克力与橡胶',()=>{
  const cases = [
    ['灰色缎面金属','satin-metal',.38,1],['深灰磨砂金属','matte-metal',.5,1],
    ['亮光金属','polished-metal',.18,1],['黑色微反光亚克力','acrylic',.18,0],
    ['黑色弹性体','rubber',.85,0],['深石墨灰','plastic',.48,0],['深灰粉末涂层','coating',.48,0],
  ] as const;
  for(const[name,finish,roughness,metalness]of cases){
    const source=new THREE.MeshPhongMaterial({color:'#1d1e20'});source.name=name;source.userData.legacyShine=40;
    expect(premiumSurface(source,'Terminal')).toBe(finish);
    const result=premiumMaterial(source,premiumSurface(source,'Terminal')) as THREE.MeshPhysicalMaterial;
    expect(result.roughness).toBeCloseTo(roughness);expect(result.metalness).toBe(metalness);
    expect(result.color.getHexString()).toBe(source.color.getHexString());
    result.dispose();source.dispose();
  }
});

test('已有 PBR 不被暗面板启发式覆盖，高保真移除旧屏幕固定亮带',()=>{
  const source=new THREE.MeshPhysicalMaterial({color:'#16181a',roughness:.72,metalness:.15,clearcoat:.1});
  source.name='黑色微反光亚克力';source.userData.rhinoPbr=true;source.userData.legacyShine=80;
  const geometry=new THREE.BoxGeometry(10,1,20);geometry.computeBoundingBox();
  const mesh=new THREE.Mesh(geometry,source);
  styleRenderMesh(mesh);
  expect(mesh.material).toBe(source);
  const result=premiumMaterial(source,premiumSurface(source,'Terminal')) as THREE.MeshPhysicalMaterial;
  expect(result.roughness).toBe(.72);expect(result.metalness).toBe(.15);expect(result.clearcoat).toBe(.1);
  const glass=new THREE.MeshPhongMaterial({color:'#090a0b'});glass.name='屏幕玻璃';
  const panel=new THREE.Mesh(geometry,glass);styleRenderMesh(panel);
  expect(panel.material.userData.screenGlass).toBe(true);
  const premium=premiumMaterial(panel.material,premiumSurface(panel.material,'')) as THREE.MeshPhysicalMaterial;
  expect(premium.onBeforeCompile).not.toBe(panel.material.onBeforeCompile);
  expect(premium.roughness).toBe(.23);
  premium.dispose();panel.material.dispose();glass.dispose();result.dispose();source.dispose();geometry.dispose();
});
