# AgentAudio

给 AI 智能体用的原生桌面音频工具（Tauri + Rust）。
解决的问题：素材没配音、AI 生成的音乐时长不可控（视频 40s、音乐 70s），
丢进剪辑软件手动对齐很烦，所以做成一个**智能体能直接调用**的工具。

界面是给人看和微调的，同一套引擎通过 MCP / HTTP / CLI 暴露给智能体。

## 打开就能用

1. 双击 `dist\AgentAudio.exe`
2. 把视频或音频拖进窗口
3. 点 **一键适配** —— 音乐立刻变成视频的精确长度
4. 点 **导出**

无边框窗口：最小化 / 最大化 / 关闭 在界面右上角，属于界面本身；顶部空白处可拖动窗口。
左侧竖排切换 工作台 / 轨道 / 智能体 / 设置。
**智能体**页能看到智能体每一次调用的记录、耗时、成功失败，以及可直接复制的 MCP 配置。

> 需要系统已安装 WebView2 运行时（Win11 自带）。`dist\` 里的 `WebView2Loader.dll` 必须和 exe 放在一起。

## 让智能体接管

App 开着时，本机 `http://127.0.0.1:8787` 已经是完整的 API；
也可以直接把 CLI 挂成 MCP：

```json
{ "mcpServers": { "agentaudio": { "command": "C:\\...\\agentaudio.exe", "args": ["mcp"] } } }
```

命令行示例：

```bat
agentaudio doctor
agentaudio demo
agentaudio fit in=song.mp3 video=clip.mp4 out=bed.wav
agentaudio fx in=voice.wav preset=podcast out=clean.wav
agentaudio caps
```

完整参数、返回值和为智能体做的省 token 设计，见 **[AGENTS.md](AGENTS.md)**。

## 功能

取音轨 · 精确适配时长（变速/裁切/循环自动选择，大比例变速优先用 rubberband 保住音乐质感，
可对齐视频整帧，可回嵌视频） ·
剪辑 · 去首尾静音 · 人声伴奏分离 · 音效拆分 · 多轨混音 + 闪避 ·
降噪/均衡/压限/响度归一(LUFS)/淡入淡出/变调/变速 等 39 种特效 ·
质量评分 · 电平 · 分段 · 波形 · 字幕导入 · 批量 · 工程存取 · 进度与取消

## 目录结构

```
dist/    可直接运行的成品：AgentAudio.exe + WebView2Loader.dll + bin/agentaudio.exe
core/    Rust 引擎：ffmpeg 编排、特效链、测量、RPC 方法表、HTTP 服务
cli/     agentaudio.exe —— CLI + MCP(stdio) + HTTP
app/     Tauri 桌面程序（同一个引擎，一个 rpc 命令）
ui/      React + TypeScript 界面
tests/   smoke.mjs —— 79 项功能验收（默认打 dist 里的成品）
         stability.mjs —— 真实素材的压力 / 恶意参数 / 资源泄漏测试（80 项）
AGENTS.md 智能体接入说明
```

## 自己编译

需要：Rust（stable）、Node 18+、ffmpeg（或安装后用 `config ffmpeg=<路径>` 指定）。

```bat
cd ui && npm install && npm run build && cd ..
cargo build --release -p agentaudio-cli
cd app && npx tauri build --no-bundle && cd ..
:: 产物
::  target\release\agentaudio.exe          命令行 / MCP / HTTP
::  target\release\agentaudio-app.exe      桌面程序（连同 WebView2Loader.dll 一起复制）
```

> 桌面程序**必须**用 `tauri build` 打，不能用 `cargo build -p agentaudio-app`。
> 后者会跳过 Tauri 的资源打包，把界面地址留在开发用的 `http://localhost:5173` 上，
> 双击只会看到「无法访问此页面」——只有开发服务器在跑时才正常。
> 非 MSVC 环境用 MinGW：先 `set RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu`。

Windows 上 Rust 需要能链接：装 Visual Studio Build Tools 时勾选 **Windows 11 SDK**，
或使用 MinGW-w64（`rustup target add x86_64-pc-windows-gnu`）。

验收：

```bat
cargo test -p agentaudio-core
node tests\smoke.mjs
:: 不带参数时打的是 dist\bin\agentaudio.exe —— 也就是成品那一个，不是构建缓存里的副本
```
