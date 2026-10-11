# AgentAudio 智能体接入说明

给 AI 智能体（Claude / Codex / 任意 MCP 客户端）使用的音频处理工具。
人类在桌面窗口里看到的是同一套引擎、同一份调用日志。

## 一句话能力

视频 40s、音乐 70s，一条命令让音乐精确变成 40s（可选直接嵌回视频）：

```
agentaudio fit in=song.mp3 video=clip.mp4 out=bed.wav
```

## 三种调用方式

| 方式 | 用途 | 入口 |
| --- | --- | --- |
| CLI | 单次调用，一行 JSON | `agentaudio <method> k=v` |
| MCP | 智能体工具挂载 | `agentaudio mcp` |
| HTTP | 常驻服务、进度轮询、音频流 | `agentaudio http --port 8787` |

桌面 App 启动时会自动在 `127.0.0.1:8787`（占用则顺延 8788…）开启同一套 HTTP 接口，
所以 App 开着的时候，智能体不需要再单独起服务。

## MCP 配置

```json
{
  "mcpServers": {
    "agentaudio": {
      "command": "C:\\Users\\<you>\\Desktop\\agentaudio\\dist\\bin\\agentaudio.exe",
      "args": ["mcp"]
    }
  }
}
```

`agentaudio caps` 的 `mcp` 字段会返回当前机器上的真实路径，可直接复制。

## 先读这一个，而不是 27 个 schema

```
agentaudio caps
```

返回：方法名 + 一行描述、全部特效 op、预设名、短键含义（`dur`=秒、`tp`=dBFS…）、
CLI 速查 10 行。实测 `caps` 4.1KB，而完整 MCP `tools/list` schema 6.7KB。

## 省 token 的设计

1. **短键**：`{out,dur,sr,ch,err,mode}` 而不是 `{output_path,duration_seconds,sample_rate,...}`。
   一次 `fit` 的完整成功响应约 180 字节。
2. **一次调用做完一件事**：`fit` 内部自己决定用 `rate`（变速）/`trim`（裁）/`loop`（补），
   智能体不需要先 probe 再算再选分支。
3. **`batch`**：N 个调用一个来回。
   ```
   agentaudio batch [{"op":"score","args":{"path":"a.wav"}},{"op":"fit","args":{...}}]
   ```
   失败项只返回 `{i,op,ok:false,e,code}`，不中断其余任务。
4. **`preset`**：一个词代替 6 个滤镜。`voice podcast music phone sfx clean loud quiet intro`。
5. **`peaks` 默认 base64**：画波形要 200×3 个浮点数，返回 9.6KB base64 而不是 30KB JSON 数组；
   智能体几乎用不到它，所以它不是默认输出的一部分。
6. **`--fields dur,sr`**：只要两个键就返回两个键。
7. **默认紧凑单行 JSON**，`--pretty` 才展开；stdout 只有结果，日志全在 stderr。
8. **错误自带 `hint`**：一次就能改对，不用试错第二轮。
   ```
   {"e":"source has no audio track","code":"noaudio","hint":"pass silence:true to create a silent bed for a voice-over"}
   ```
9. **`@file` / `k=v`**：长参数（`tracks`、`chain`、`jobs`）可放文件里，命令行保持短。
10. **`--root DIR`**：智能体用短相对路径，返回值同样按 root 缩短。
11. **`log` 默认只给智能体的调用**：桌面窗口自己的轮询（`jobs` / `log` / `caps` / `doctor` /
    `project`）在记录里带 `ui:1`，`log` 默认把它们滤掉，`n` 和 `fails` 也按过滤后的算，
    所以智能体看到的次数就是自己干的活。传 `ui:true` 才拿全量。

## 方法清单

| 方法 | 作用 | 关键参数 |
| --- | --- | --- |
| `probe` | 时长/采样率/声道/编码 | `path` |
| `extract` | 从视频取音轨 | `in out stream silence fmt` |
| `fit` | **让音频精确等于目标时长** | `in dur\|video mode engine fps fade mux` |
| `cut` | 裁一段 | `in start end\|dur fi fo` |
| `silence` | 去首尾静音 | `in noise` |
| `separate` | 人声/伴奏分离 | `in mode:center\|karaoke\|ai stems` |
| `split` | 拆成多个文件（音效） | `in by:silence\|parts\|n n` |
| `mix` | 多轨混音 + 闪避 | `tracks duck norm target fade` |
| `fx` | 特效链 | `in chain\|preset` |
| `render` | 转格式/采样率 | `in fmt sr ch br` |
| `score` | 真实质量分（`lufs=false` 跳过 R128 那一遍） | `path lufs` |
| `levels` | 每声道电平 | `path` |
| `sections` | 能量分段 | `path min len` |
| `peaks` | 波形包络 | `path n ch enc` |
| `transcribe` | 字幕/文稿 | `path from` |
| `batch` | 批量 | `jobs` |
| `project` | 存取工程 | `name data load` |
| `config` | 读写设置（ffmpeg 路径等） | `ffmpeg work` |
| `jobs` `cancel` `log` `clear` | 进度与调用记录 | `id n` |
| `caps` `doctor` `demo` `ops` `presets` `help` | 自描述与环境 | — |

## 数值约定

- 时长一律**秒**（浮点），电平一律 **dBFS**，响度 **LUFS**。
- `fit` 返回 `err` = 实际与目标的秒差；`fps` 给定时会自动对齐整帧并返回整帧误差。
- `fit` 变速优先用 `rubberband`（相位声码器，70s→40s 这种大比例音乐不发糊），
  本机 ffmpeg 没这个滤镜时自动退回 `atempo` 链。返回的 `engine` 说明实际用了哪个；
  `engine:"atempo"` 可强制。只在 `mode:"rate"` 时才有意义。
- `fit` 的 `dur` 上限 43200 秒（12 小时）。超过直接 `param` 报错——防止把毫秒当秒传进来，
  那会让 ffmpeg 一直写到磁盘满。想跟着视频走就传 `video=<文件>`，长度自动读。
- `score` 的 4 个子项是启发式加权（清晰度 0.30 / 平衡 0.24 / 动态 0.20 / 底噪 0.26），
  输入量全部来自实测采样，权重本身不是标准。
- `score` 的 `lufs_src` 标明响度数字的来源：`r128` = ffmpeg 真实 EBU R128 测量，
  `estimate` = 帧电平估算。传 `lufs=false` 可跳过 R128 那一遍（长文件下是唯一的时间大头）。
- 全静音文件返回 `silent:true`、`score:0`、`note:"no audible signal"`，
  不会给一个看起来很正常的中间分数。

## 长文件

分析（peaks / score / levels / sections）是**流式**的：内存恒定 ~5-7 MB，
20 分钟文件 `score lufs=false` 用时 0.75s，288s 真实歌曲 0.42s。
唯一与长度线性相关的是 R128 响度测量（约 19 倍速实时），所以它可以被跳过、
也可以被取消（这些方法都注册为 job，UI 与 `cancel` 都能中断它们）。

## 已知边界

- `separate mode:ai` 需要本机装 `demucs`；没装时返回 `{"code":"engine"}` 并给出替代方案，
  不会假装成功。默认 `center` 模式是相位对消，单声道兼容素材效果有限。
- `transcribe` 不自带语音模型：可导入 `.srt/.vtt/.json`，或 PATH 上有 whisper-cli 时自动使用。
- `fit` 的 `trim` 永远从 0 开始截取；想保留副歌等中段，先 `cut` 出区间再 `fit`。
- `out=` 不是沙盒：绝对路径就写在那儿（这工具的意义就是把音频放到用户视频旁边）。
  传了 `--root DIR` 时，相对路径会被关在 DIR 里，`../` 也爬不出去。
- 40 分钟以上的单个 ffmpeg 任务会被判超时并杀掉进程。
- `project` 的 `data` 是一整块不透明 JSON，桌面窗口也往里写：导入了哪些素材、目标时长，
  放在 `session` 键下，重启时自动恢复。所以智能体 `project save data=...` 会连带覆盖
  窗口下次打开的工程；要自己存东西就另起一个 `name`。
