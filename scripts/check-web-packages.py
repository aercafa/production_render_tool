"""Verify portable archive contents and emit checksums without extracting user data."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import stat
from zipfile import ZipFile

root=Path(__file__).resolve().parents[1]
version=json.loads((root/'package.json').read_text(encoding='utf-8'))['version']
rows=[]
for platform in ['windows-x64','macos-arm64','macos-x64']:
    archive=root/'release'/'web'/f'RenderWorkbench-Web-{platform}.zip'
    with ZipFile(archive) as z:
        assert z.testzip() is None
        metadata=json.loads(z.read('RenderWorkbench-Web/build-info.json'))
        assert metadata['version']==version and metadata['platform']==platform
        assert metadata['indexSha256']==hashlib.sha256(z.read('RenderWorkbench-Web/dist/index.html')).hexdigest()
        assert z.read('RenderWorkbench-Web/VERSION.txt').strip().decode()==version
        for name in z.namelist():
            p=PurePosixPath(name)
            assert not p.is_absolute() and '..' not in p.parts
            assert not any(x in name for x in ['local-fixtures/','docs/','.3dm','.env','settings.json','model-imports.json'])
        for required in ['server/model-imports.mjs','server/pick-models.ps1']:
            assert z.read('RenderWorkbench-Web/'+required)
        if platform=='windows-x64':
            assert z.read('RenderWorkbench-Web/runtime/node.exe').startswith(b'MZ')
        else:
            script=z.read('RenderWorkbench-Web/Start-Workbench.command')
            assert script.startswith(b'#!/bin/bash\n') and b'\r' not in script
            assert z.read('RenderWorkbench-Web/runtime/node')[:4]==b'\xcf\xfa\xed\xfe'
            for name in ['runtime/node','Start-Workbench.command']:
                assert z.getinfo('RenderWorkbench-Web/'+name).external_attr>>16&stat.S_IXUSR
    with archive.open('rb') as stream: sha=hashlib.file_digest(stream,'sha256').hexdigest()
    rows.append({'file':archive.name,'version':version,'bytes':archive.stat().st_size,'sha256':sha})
(root/'release'/'web'/'SHA256SUMS.txt').write_text(''.join(r['sha256']+'  '+r['file']+'\n' for r in rows),encoding='utf-8')
print(json.dumps(rows,indent=2))
