"""Build portable ZIPs from the current dist and pinned official Node.js archives."""
import argparse
import hashlib
import json
from pathlib import Path
import stat
import tarfile
from urllib.request import urlretrieve
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


NODE_VERSION = "24.22.3"
RUNTIMES = {
    "windows-x64": (
        "win-x64.zip", "e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f",
        "node.exe", "Start-Workbench.cmd",
    ),
    "macos-arm64": (
        "darwin-arm64.tar.gz", "ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd",
        "bin/node", "Start-Workbench.command",
    ),
    "macos-x64": (
        "darwin-x64.tar.gz", "977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7",
        "bin/node", "Start-Workbench.command",
    ),
}
ROOT = Path(__file__).resolve().parents[1]
VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
OUTPUT = ROOT / "release" / "web"
CACHE = OUTPUT / "node-downloads"
SERVER = (
    "start-web.mjs", "local-workbench.mjs", "assistant.mjs", "material-presets.json",
    "material-rules.mjs", "rhino-mesh.py", "pick-folder.ps1", "model-imports.mjs", "pick-models.ps1",
)


def archive_hash(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def runtime_files(suffix, checksum, executable):
    name = f"node-v{NODE_VERSION}-{suffix}"
    archive = CACHE / name
    if not archive.exists() or archive_hash(archive) != checksum:
        partial = archive.with_suffix(".part")
        try:
            urlretrieve(f"https://nodejs.org/dist/v{NODE_VERSION}/{name}", partial)
            if archive_hash(partial) != checksum:
                raise ValueError(f"Checksum mismatch for {name}")
            partial.replace(archive)
        finally:
            partial.unlink(missing_ok=True)
    base = name.removesuffix(".zip").removesuffix(".tar.gz")
    if suffix.endswith(".zip"):
        with ZipFile(archive) as source:
            return source.read(f"{base}/{executable}"), source.read(f"{base}/LICENSE")
    with tarfile.open(archive, "r:gz") as source:
        return source.extractfile(f"{base}/{executable}").read(), source.extractfile(f"{base}/LICENSE").read()


def write_entry(archive, name, data, executable=False):
    entry = ZipInfo(f"RenderWorkbench-Web/{name}")
    entry.create_system = 3
    entry.external_attr = (stat.S_IFREG | (0o755 if executable else 0o644)) << 16
    archive.writestr(entry, data, compress_type=ZIP_DEFLATED, compresslevel=6)


def package(platform):
    suffix, checksum, executable, launcher = RUNTIMES[platform]
    node, license_text = runtime_files(suffix, checksum, executable)
    target = OUTPUT / f"RenderWorkbench-Web-{platform}.zip"
    partial = target.with_suffix(".tmp")
    try:
        with ZipFile(partial, "w") as archive:
            write_entry(archive, launcher, (ROOT / launcher).read_bytes(), launcher.endswith(".command"))
            write_entry(archive, f"runtime/{Path(executable).name}", node, True)
            write_entry(archive, "runtime/NODE-LICENSE.txt", license_text)
            write_entry(archive, "打开说明.txt", (ROOT / "QUICK-START.txt").read_bytes())
            write_entry(archive, "VERSION.txt", (VERSION + "\n").encode())
            write_entry(archive, "build-info.json", json.dumps({
                "version": VERSION, "platform": platform, "node": NODE_VERSION,
                "engine": "threejs", "indexSha256": archive_hash(ROOT / "dist" / "index.html"),
            }, indent=2).encode())
            for name in SERVER:
                write_entry(archive, f"server/{name}", (ROOT / "server" / name).read_bytes())
            for file in sorted((ROOT / "dist").rglob("*")):
                if file.is_file():
                    write_entry(archive, file.relative_to(ROOT).as_posix(), file.read_bytes())
        partial.replace(target)
    finally:
        partial.unlink(missing_ok=True)
    print(f"{archive_hash(target)}  {target.name}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("platform", nargs="*", choices=[*RUNTIMES, "all"], default=["all"])
    args = parser.parse_args()
    if not (ROOT / "dist" / "index.html").is_file():
        parser.error("Run npm run build first.")
    CACHE.mkdir(parents=True, exist_ok=True)
    for platform in RUNTIMES if "all" in args.platform else args.platform:
        package(platform)
