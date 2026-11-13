# 模型出图工作台

把 OBJ 或 Rhino 3DM 做成带尺寸的产品展示图。画布左侧是轴测图，右侧是同尺度的俯视、正视和右视图。适合展项、设备外壳和产品方案的材质对照、外形沟通与汇报出图。尺寸标注基于导入的网格范围或手填名义值。

功能实现、关键参数、故障复盘和后续迭代计划见 [项目复盘与开发经验](docs/project-retrospective.md)。

## 快速运行

安装 Git、Node.js 24 LTS 和支持 WebGL2 的 Chrome 或 Edge。首次安装依赖需要网络。渲染和普通 PNG 导出在本机完成。

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
| 导入 | OBJ 可指定 mm、cm、m、in、ft。3DM 读取源单位。模型自动居中适配。 |
| 渲染 | 棚拍材质、高保真棚拍、灰白模线描。左侧轴测有六个角度。 |
| 曝光 | −10 到 +10，默认 0。两种棚拍风格的预览和 PNG 共用曝光。 |
| 标注 | 总宽、总深、总高可覆盖；可编辑题目、说明、辅助线端点和文字位置。正交自动或自由拉线，支持撤回和重做。 |
| 导出 | 6000 × 4000 PNG、300 dpi。双倍线性超采样后降采样。 |
| 缓存 | 转换后的 3DM 网格缓存 24 小时。设置可修改缓存、默认导出位置并手动清理。 |

## 渲染助手

从画布左上方打开助手。在「API 设置」填写兼容 Chat Completions 的 URL、模型名、API Key，再测试并保存。URL 可以是基础地址或完整的 `/chat/completions` 端点，例如 `https://api.deepseek.com`。本机兼容服务可以使用回环 HTTP，按需留空 Key。容器内的回环地址指容器自身。

「要修改的范围」默认根据部件名称、大小、位置和材质定位。选择某种材质可编辑其所有使用位置，也可选择局部部件或点击「在图上选部件」，只修改选中的表面。没有源材质的部件也支持单独修改。复杂模型中找不到目标时，可以先在预览上点选。

- 例：「把选中的台面材质换成亚光浅橡木，木纹细一点。」
- 例：「用高保真棚拍，曝光降一档，接缝阴影稍强一点。」
- 提交后显示分析状态，确认建议后显示应用和刷新状态。按住画布工具栏的「对比」可看最近一次应用前的效果，松开回到当前画面。也可用空格或 Enter 按住对比。
- 预览和 PNG 同步使用已应用的改动，可逐次撤销。对比仅影响屏幕预览。

材质预设包括浅橡木、深胡桃木、亚光金属、亮光金属、塑料、橡胶、人造石、透明玻璃、黑玻璃屏幕和自发光。木纹可调方向、密度和细节，石材可调颗粒，屏幕可保留原画面贴图。玻璃使用实时薄片透射近似。模型与渲染器共用 [材质参数库](server/material-presets.json) 和 [材质编辑规则](server/material-rules.mjs)。默认灯光、反射和 AO 参数见 [渲染配置](src/render-config.ts)。

发送给 API 的是对话以及材质和部件摘要。支持图像输入的模型可通过「随本轮发送预览图」参考当前画面，每次勾选仅发送一轮。模型文件、贴图和导出的 PNG 在本机处理。API Key 保存在本机设置文件中，设置接口只返回是否已保存。对话、对比和材质修改属于当前会话，重新导入或刷新页面会清除会话状态。

## 开发与测试

`npm run dev` 启动开发服务器。网页依赖 TypeScript、Vite、Three.js、rhino3dm WASM 和本机 Node 服务。设置、Rhino 网格转换和模型 API 经本机服务工作，静态站点托管只提供前端文件，无法提供这些接口。

`npm run build` 检查类型并构建。安装 Chrome 后可运行 `npm test`。测试使用合成模型和模拟 Chat Completions 服务。指定 `RENDER_32_ORIGINAL`、`RENDER_32_MESH`、`RENDER_MISSING_3DM`、`RENDER_COMPLETE_3DM` 或 `RENDER_CHARIOT_3DM` 可加入相应真实文件测试。
