/** Synthetic millimeter test fixture; Z up, front at -Y. */
export function fixtureFiles(): File[] {
  const pieces = [
    ['底座', [-365, -160, 0], [365, 160, 32], 'base'],
    ['立柱', [-75, -48, 32], [75, 65, 720], 'frame'],
    ['显示外壳', [-371, -59, 690], [371, 66, 1050], 'frame'],
    ['玻璃面板', [-345, -63, 712], [345, -59, 1030], 'glass'],
    ['显示区域', [-313, -64, 738], [313, -63, 1004], 'display'],
    ['示例信息线一', [-272, -65, 936], [-16, -64, 953], 'highlight'],
    ['示例信息线二', [-272, -65, 903], [-100, -64, 916], 'highlight'],
  ] as const;
  let obj = 'mtllib sample.mtl\n';
  pieces.forEach(([name, [x, y, z], [X, Y, Z], material], n) => {
    obj += 'o ' + name + '\nusemtl ' + material + '\n';
    for (const p of [[x,y,z],[X,y,z],[X,Y,z],[x,Y,z],[x,y,Z],[X,y,Z],[X,Y,Z],[x,Y,Z]]) {
      obj += 'v ' + p.join(' ') + '\n';
    }
    for (const f of [[4,3,2,1],[5,6,7,8],[1,2,6,5],[2,3,7,6],[3,4,8,7],[4,1,5,8]]) {
      obj += 'f ' + f.map(i => i + n * 8).join(' ') + '\n';
    }
  });
  const mtl = [
    'newmtl base\nKd 0.22 0.27 0.32',
    'newmtl frame\nKd 0.39 0.46 0.53',
    'newmtl glass\nKd 0.05 0.08 0.12',
    'newmtl display\nKd 0.08 0.27 0.52\nKe 0.02 0.06 0.13',
    'newmtl highlight\nKd 0.60 0.80 0.96\nKe 0.12 0.21 0.35',
  ].join('\n');
  return [new File([obj], '示例终端.obj'), new File([mtl], 'sample.mtl')];
}
