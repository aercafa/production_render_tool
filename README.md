# 模型出图工作台

把 OBJ 或 Rhino 3DM 做成带尺寸的产品展示图。画布左侧是轴测图，右侧是同尺度的俯视、正视和右视图。适合展项、设备外壳和产品方案的材质对照、外形沟通与汇报出图。尺寸标注基于导入的网格范围或手填名义值。

当前构建：**v0.3.2**。新导入会把模型文件名自动填入底部辅助说明，导出按最后编辑的题目或辅助说明命名。高保真采用 Three.js 柔光棚拍，支持双轴旋转光箱、细分旧式材质映射和按模型导入批次记录的本地渲染历史。界面左上角可核对版本。升级时先关闭旧启动窗口，更新原文件夹中的程序文件后重新启动。

## 快速运行

### 下载 ZIP 后双击启动

| 电脑 | 下载便携包 | 解压后双击 |
| --- | --- | --- |
| Windows x64 | [Windows ZIP](https://github.com/aercafa/production_render_tool/releases/latest/download/RenderWorkbench-Web-windows-x64.zip) | `Start-Workbench.cmd` |
| Mac · Apple 芯片 | [Apple 芯片 ZIP](https://github.com/aercafa/production_render_tool/releases/latest/download/RenderWorkbench-Web-macos-arm64.zip) | `Start-Workbench.command` |
| Mac · Intel | [Intel ZIP](https://github.com/aercafa/production_render_tool/releases/latest/download/RenderWorkbench-Web-macos-x64.zip) | `Start-Workbench.command` |

完整解压后再启动。便携包包含 Node.js 和预编译网页，启动无需安装依赖。工作台会在默认浏览器打开，推荐 Chrome 或 Edge。使用期间保留启动窗口，关闭窗口或按 Ctrl+C 停止服务。若默认端口被占用，启动台会自动尝试下一端口。下载的 macOS 脚本可能需要在系统设置中允许打开。

Windows 安装版可从 [最新发布页](https://github.com/aercafa/production_render_tool/releases/latest) 下载 EXE。Windows／Mac 源码启动台会检测源码变化并重新构建，依赖未变化时复用已安装依赖；便携包直接运行随包构建的网页。

通过 GitHub 的 **Code → Download ZIP** 下载的是源码。源码目录也提供双击入口，需先安装 Node.js 24 LTS，第一次启动需联网安装依赖和构建。以下是命令行方式。

### Windows · PowerShell

```powershell
git clone https://github.com/aercafa/production_render_tool.git
cd production_render_tool
npm ci
npm run build
npm run preview -- --port 5173 --strictPort
```

打开 [本机工作台](http://127.0.0.1:5173)。OBJ 可连同 MTL、贴图一起选择。缺显示网格的 3DM 可调用本机已授权的 Rhino 8 处理。非标准安装位置可在启动前设置 `$env:RENDER_RHINO_EXE = 'D:\路径\Rhino.exe'`。

### macOS · 终端

Apple Silicon 安装 arm64 版 Node.js，Intel Mac 安装 x64 版。使用 Mac 本机重新安装依赖。

```bash
git clone https://github.com/aercafa/production_render_tool.git
cd production_render_tool
npm ci
npm run build
npm run preview -- --port 5173 --strictPort
```

用 Chrome 打开 [本机工作台](http://127.0.0.1:5173)。当前 macOS 可试用 OBJ 或带完整显示网格的 3DM。缺网格时先在 Rhino 中另存带网格副本，或导出 OBJ/MTL。PNG 可使用浏览器下载，也可在设置手填已有目录的绝对路径。macOS 实机和 Safari 的渲染性能尚待验收。

### Docker（可选）

安装 Docker Desktop 或带 Compose 的 Docker Engine。在仓库根目录运行：

```bash
docker compose up --build
```

打开 [本机工作台](http://127.0.0.1:5173)。Compose 仅向宿主机回环地址发布端口，适合单机使用。容器版读取 OBJ 和已有网格的 3DM，PNG 通过浏览器下载。Rhino 曲面转换和系统目录选择使用 Windows 本机部署。设置保存在 `workbench-data` 卷。用 `docker compose down` 停止服务。若 5173 已被占用，可把 `compose.yaml` 端口映射改成 `127.0.0.1:5174:5173`，再打开 5174。

## 操作与关键参数

| 功能 | 参数与行为 |
| --- | --- |
| 导入 | OBJ 可指定 mm、cm、m、in、ft。3DM 读取源单位，按对象、图层和块实例的可见状态导入。模型按可见范围居中。 |
| 渲染 | 棚拍材质、高保真棚拍、灰白模线描。左侧轴测有六个角度。 |
| 曝光 | −10 到 +10，默认 0。两种棚拍风格的预览和 PNG 共用曝光。 |
| 高保真光箱 | Z 轴水平转、Y 轴垂直转，各 −180°～180°，默认 0°。实际灯光与环境反射同步绕模型中心旋转；预览和 PNG 使用相同角度。 |
| 渲染历史 | 每次成功导入新增一条记录；同一次导入的材质、灯光、曝光、视角和标注调整都更新原记录，不累加操作历史。显示最近 18 次导入的缩略图、导入时间和来源信息；点击恢复该批次最后效果。取消或失败不会新增。 |
| 标注 | 新导入默认将模型文件名（去掉 `.3dm`／`.obj`）填入底部辅助说明，可继续编辑。题目、说明、总宽深高和辅助线均可修改；历史回查保留保存的标注。 |
| 导出 | 6000 × 4000 PNG、300 dpi。命名依次使用最新题目、最新辅助说明、原模型名。例如题目为 L29 则导出 L29.png，无题目而说明为 L29终端 则导出 L29终端.png。自动处理非法文件名字符；已有同名文件时保留原文件。 |
| 缓存 | Windows 自动转换时，3DM 原文件分段写入临时目录，上限 1 GiB；转换结果上限 512 MiB，缓存 24 小时。设置可修改缓存、默认导出位置并手动清理。 |

## 渲染助手

从画布左上方打开助手。在「API 设置」填写兼容 Chat Completions 的 URL、模型名、API Key，再测试并保存。URL 可以是基础地址或完整的 `/chat/completions` 端点，例如 `https://api.deepseek.com`。本机兼容服务可以使用回环 HTTP，按需留空 Key。容器内的回环地址指容器自身。

「要修改的范围」默认根据部件名称、大小、位置和材质定位。选择某种材质可编辑其所有使用位置，也可选择局部部件或点击「在图上选部件」，只修改选中的表面。没有源材质的部件也支持单独修改。复杂模型中找不到目标时，可以先在预览上点选。

- 例：「把选中的台面材质换成亚光浅橡木，木纹细一点。」
- 例：「用高保真棚拍，曝光降一档，接缝阴影稍强一点。」
- 提交后显示分析状态，确认建议后显示应用和刷新状态。按住画布工具栏的「对比」可看最近一次应用前的效果，松开回到当前画面。也可用空格或 Enter 按住对比。
- 预览和 PNG 同步使用已应用的改动，可逐次撤销。对比仅影响屏幕预览。

材质预设包括浅橡木、深胡桃木、亚光金属、亮光金属、塑料、橡胶、人造石、透明玻璃、黑背高反亚克力、黑玻璃屏幕和自发光。木纹可调方向、密度和细节，石材可调颗粒，屏幕可保留原画面贴图。玻璃使用实时薄片透射近似。高保真按名称细分旧式缎面、磨砂及亮面金属、塑料、橡胶和亚克力，保留已有 PBR 及贴图；金属／塑料加入轻微、经过滤波的粗糙度变化。模型与渲染器共用 [材质参数库](server/material-presets.json) 和 [材质编辑规则](server/material-rules.mjs)。默认灯光、反射和 AO 参数见 [渲染配置](src/render-config.ts)。

发送给 API 的是对话以及材质和部件摘要。支持图像输入的模型可通过「随本轮发送预览图」参考当前画面，每次勾选仅发送一轮。模型文件、贴图和导出的 PNG 在本机处理。API Key 保存在本机设置文件中，设置接口只返回是否已保存。对话和撤销栈属于当前会话；渲染历史存放在当前浏览器、当前工作台地址的 localStorage，刷新后保留。每次导入为独立批次，同一个文件重复导入也计为两次；当前批次的后续操作只更新最后效果。旧版操作历史首次升级会按模型合并为最后一条可用记录。

Windows「导入模型」使用原生文件选择器，记录完整来源路径，并可在回查历史时自动重读已选源文件。来源清单保存在本机设置目录的 `model-imports.json`，仅允许重新读取曾通过选择器选中的文件。拖拽、浏览器选择和 macOS 网页版无法获取完整绝对路径，界面如实标记来源；本次页面内可回查原文件，刷新后按提示重新选择同一组源文件。源文件移动或内容变化时会提示，避免将旧材质覆盖到不匹配的模型。历史不复制整份模型或保存 API Key；存储不可用时仅保留本次页面记录。清理浏览器数据会移除历史记录。

## 开发与测试

`npm run dev` 启动开发服务器。网页依赖 TypeScript、Vite、Three.js、rhino3dm WASM 和本机 Node 服务。设置、Rhino 网格转换和模型 API 经本机服务工作，静态站点托管只提供前端文件，无法提供这些接口。

`npm run build` 检查类型并构建。安装 Chrome 后可运行 `npm test`。测试使用合成模型和模拟 Chat Completions 服务。指定 `RENDER_32_ORIGINAL`、`RENDER_32_MESH`、`RENDER_MISSING_3DM`、`RENDER_COMPLETE_3DM` 或 `RENDER_CHARIOT_3DM` 可加入相应真实文件测试。

维护便携包时，先执行 `npm run build`，再用 Python 3.11 或以上运行 `python scripts/package-web.py all`。脚本校验固定版本的 Node.js 下载，生成的 ZIP 位于 `release/web/`。
