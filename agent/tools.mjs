import { execFile } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AgentError } from './server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const EXE = path.join(PROJECT_ROOT, 'dist', 'bin', 'agentaudio.exe');

export const project = {
  id: 'agentaudio',
  name: 'AgentAudio',
  version: '0.1.0',
  summary: '本地音频智能处理引擎：音频时长精准拟合对齐、多轨混音闪避、人声伴奏分离、音效处理与质检。',
  port: 8788
};
export const projectId = 'agentaudio';

function runCli(method, args = {}) {
  return new Promise((resolve, reject) => {
    if (!existsSync(EXE)) {
      return reject(new AgentError('engine_missing', `未找到可执行文件: ${EXE}`));
    }
    const cliArgs = [method];
    for (const [k, v] of Object.entries(args)) {
      if (v === undefined || v === null) continue;
      if (typeof v === 'object') {
        cliArgs.push(`${k}=${JSON.stringify(v)}`);
      } else {
        cliArgs.push(`${k}=${v}`);
      }
    }
    execFile(EXE, cliArgs, { cwd: PROJECT_ROOT, timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        let msg = stderr ? stderr.trim() : (stdout ? stdout.trim() : err.message);
        try {
          const parsed = JSON.parse(stdout);
          if (parsed && (parsed.e || parsed.error)) {
            msg = parsed.e || parsed.error;
          }
        } catch { /* not json */ }
        return reject(new AgentError('exec_failed', msg));
      }
      try {
        const out = JSON.parse(stdout.trim());
        resolve(out);
      } catch (parseErr) {
        resolve({ raw: stdout.trim(), stderr: stderr.trim() });
      }
    });
  });
}

export const tools = [
  {
    name: 'agentaudio.caps',
    description: '返回音频处理引擎的全部能力说明、特效算子(ops)、预设(presets)及系统状态。',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    risk: 'read',
    handler: async () => runCli('caps')
  },
  {
    name: 'agentaudio.doctor',
    description: '检查本机音频处理环境（FFmpeg 状态、工作目录、临时配额等）。',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    risk: 'read',
    handler: async () => runCli('doctor')
  },
  {
    name: 'agentaudio.probe',
    description: '探测音频或视频文件的时长(dur)、采样率(sr)、声道数(ch)与编码格式。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '待探测的音频或视频文件路径' }
      },
      required: ['path'],
      additionalProperties: false
    },
    risk: 'read',
    handler: async ({ path: p }) => runCli('probe', { path: p })
  },
  {
    name: 'agentaudio.fit',
    description: '核心工具：让背景音频精确等于目标时长（秒）或匹配给定视频的时长，内部自动选择变速/裁剪/循环/淡入淡出。',
    input_schema: {
      type: 'object',
      properties: {
        in: { type: 'string', description: '输入音频路径' },
        out: { type: 'string', description: '输出目标路径' },
        dur: { type: 'number', description: '目标时长（秒），dur 与 video 二选一' },
        video: { type: 'string', description: '参考视频路径（自动提取视频长度并可直接复用）' },
        mode: { type: 'string', enum: ['rate', 'trim', 'loop'], description: '拟合模式：rate变速，trim裁剪，loop循环补充' },
        engine: { type: 'string', enum: ['rubberband', 'atempo'], description: '变速引擎：rubberband(保音质声码器)或atempo' },
        fps: { type: 'number', description: '视频帧率，给定后自动对齐整帧' }
      },
      required: ['in', 'out'],
      additionalProperties: false
    },
    risk: 'exec',
    handler: async (input) => runCli('fit', input)
  },
  {
    name: 'agentaudio.cut',
    description: '精确剪切音频时间区间，支持淡入淡出。',
    input_schema: {
      type: 'object',
      properties: {
        in: { type: 'string', description: '输入音频路径' },
        out: { type: 'string', description: '输出音频路径' },
        start: { type: 'number', description: '起始时间（秒）' },
        end: { type: 'number', description: '结束时间（秒）' },
        dur: { type: 'number', description: '片段时长（秒，与 end 互斥）' },
        fi: { type: 'number', description: '淡入时长（秒）' },
        fo: { type: 'number', description: '淡出时长（秒）' }
      },
      required: ['in', 'out', 'start'],
      additionalProperties: false
    },
    risk: 'exec',
    handler: async (input) => runCli('cut', input)
  },
  {
    name: 'agentaudio.silence',
    description: '去除音频首尾静音部分。',
    input_schema: {
      type: 'object',
      properties: {
        in: { type: 'string', description: '输入音频路径' },
        out: { type: 'string', description: '输出音频路径' },
        noise: { type: 'number', description: '静音判定门限分贝（例如 -50）' }
      },
      required: ['in', 'out'],
      additionalProperties: false
    },
    risk: 'exec',
    handler: async (input) => runCli('silence', input)
  },
  {
    name: 'agentaudio.separate',
    description: '人声与伴奏分离（支持 center 中置相位对消或 Demucs AI 离线分离）。',
    input_schema: {
      type: 'object',
      properties: {
        in: { type: 'string', description: '输入音频文件路径' },
        out: { type: 'string', description: '输出路径前缀或目录' },
        mode: { type: 'string', enum: ['center', 'karaoke', 'ai'], description: '分离算法模式' }
      },
      required: ['in', 'out'],
      additionalProperties: false
    },
    risk: 'exec',
    handler: async (input) => runCli('separate', input)
  },
  {
    name: 'agentaudio.mix',
    description: '多轨混音：支持音量平衡、口播自动闪避(ducking)与响度标准化。',
    input_schema: {
      type: 'object',
      properties: {
        tracks: { type: 'array', description: '轨道数组：每项包含 path, offset, gain 等' },
        out: { type: 'string', description: '混音产物路径' },
        duck: { type: 'boolean', description: '是否启用闪避' },
        norm: { type: 'boolean', description: '是否进行真峰值归一化' }
      },
      required: ['tracks', 'out'],
      additionalProperties: false
    },
    risk: 'exec',
    handler: async (input) => runCli('mix', input)
  },
  {
    name: 'agentaudio.fx',
    description: '应用音频滤镜链或预设（预设如 voice, podcast, music, phone, sfx, clean, loud）。',
    input_schema: {
      type: 'object',
      properties: {
        in: { type: 'string', description: '输入音频路径' },
        out: { type: 'string', description: '输出音频路径' },
        preset: { type: 'string', description: '预设名称：voice/podcast/music/phone/sfx/clean/loud' },
        chain: { type: 'string', description: '自定义滤镜串联' }
      },
      required: ['in', 'out'],
      additionalProperties: false
    },
    risk: 'exec',
    handler: async (input) => runCli('fx', input)
  },
  {
    name: 'agentaudio.render',
    description: '转换音频文件格式、采样率与声道（支持 mp3, wav, flac, aac 等）。',
    input_schema: {
      type: 'object',
      properties: {
        in: { type: 'string', description: '输入音频路径' },
        out: { type: 'string', description: '输出音频路径' },
        fmt: { type: 'string', description: '目标格式，例如 wav, mp3' },
        sr: { type: 'number', description: '目标采样率，例如 44100, 48000' },
        ch: { type: 'number', description: '声道数：1 或 2' }
      },
      required: ['in', 'out'],
      additionalProperties: false
    },
    risk: 'exec',
    handler: async (input) => runCli('render', input)
  },
  {
    name: 'agentaudio.score',
    description: '评估音频质量：清晰度、平衡度、动态范围、底噪与 LUFS 响度。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '音频文件路径' },
        lufs: { type: 'boolean', description: '是否执行完整 EBU R128 响度测量（长音频跳过可加速）' }
      },
      required: ['path'],
      additionalProperties: false
    },
    risk: 'read',
    handler: async (input) => runCli('score', input)
  },
  {
    name: 'agentaudio.batch',
    description: '批量执行多项音频操作，在一个批次内完成。',
    input_schema: {
      type: 'object',
      properties: {
        jobs: { type: 'array', description: '任务数组，每项包含 op 与 args' }
      },
      required: ['jobs'],
      additionalProperties: false
    },
    risk: 'exec',
    handler: async (input) => runCli('batch', input)
  }
];
