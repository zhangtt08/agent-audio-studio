// Single-method RPC bridge to the Rust engine.
// Inside Tauri: one `invoke('rpc', { method, params })` command.
// Outside Tauri (plain browser dev): POST http://127.0.0.1:8787/api/<method>.

export type V = Record<string, unknown>;

declare global {
  interface Window {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
    /** Set by the app before page scripts run: port of the embedded HTTP server. */
    __AA_PORT__?: number;
  }
}

// The app embeds the HTTP server; a plain-browser dev session uses the default.
export const HTTP_BASE = `http://127.0.0.1:${
  (typeof window !== 'undefined' && window.__AA_PORT__) || 8787
}`;

export const isTauri: boolean =
  typeof window !== 'undefined' &&
  (!!window.__TAURI__ || !!window.__TAURI_INTERNALS__);

export class ApiError extends Error {
  code: string;
  msg: string;
  hint?: string;

  constructor(code: string, msg: string, hint?: string) {
    super(hint ? `${msg} — ${hint}` : msg);
    this.name = 'ApiError';
    this.code = code;
    this.msg = msg;
    this.hint = hint;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Normalize `{code,msg,hint?}` (Tauri rejection) and `{e,code,hint}` (HTTP JSON) into ApiError. */
export function toApiError(raw: unknown): ApiError {
  if (raw instanceof ApiError) return raw;
  if (typeof raw === 'string') return new ApiError('rpc', raw);
  if (raw instanceof Error) return new ApiError('rpc', raw.message || String(raw));
  const o = (raw ?? {}) as V;
  const code = str(o.code) ?? 'rpc';
  const msg = str(o.msg) ?? str(o.e) ?? str(o.message) ?? '请求失败';
  const hint = str(o.hint);
  return new ApiError(code, msg, hint);
}

export function describeError(e: unknown): { msg: string; hint?: string } {
  const a = toApiError(e);
  return { msg: a.msg, hint: a.hint };
}

type InvokeFn = <T = unknown>(cmd: string, args?: V) => Promise<T>;

let invokeCache: InvokeFn | null = null;

async function tauriInvoke<T>(method: string, params: V): Promise<T> {
  if (!invokeCache) {
    const mod = (await import('@tauri-apps/api/core')) as { invoke?: InvokeFn };
    if (typeof mod.invoke !== 'function') throw new ApiError('tauri', 'invoke 不可用');
    invokeCache = mod.invoke;
  }
  return (await invokeCache<T>('rpc', { method, params })) as T;
}

/**
 * The response body IS the result object. Failures are signalled by a thrown
 * `{code,msg,hint?}` in Tauri or a non-2xx `{e,code,hint}` over HTTP, so an
 * in-payload `ok:false` (e.g. `transcribe`) stays intact as data.
 */
function unwrap(json: unknown): V {
  const o = (json ?? {}) as V;
  return o;
}

export async function rpc<T = V>(method: string, params: V = {}): Promise<T> {
  if (isTauri) {
    try {
      const raw = await tauriInvoke<unknown>(method, params);
      return unwrap(raw) as unknown as T;
    } catch (e) {
      throw toApiError(e);
    }
  }
  let res: Response;
  try {
    res = await fetch(`${HTTP_BASE}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params ?? {}),
    });
  } catch (e) {
    throw new ApiError('offline', '无法连接后端', `${HTTP_BASE} 未启动`);
  }
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      if (!res.ok) throw new ApiError('http', `HTTP ${res.status}`, text.slice(0, 240));
      throw new ApiError('json', '响应不是合法 JSON', text.slice(0, 240));
    }
  }
  if (!res.ok) {
    const o = (json ?? {}) as V;
    throw new ApiError(str(o.code) ?? 'http', str(o.e) ?? str(o.msg) ?? `HTTP ${res.status}`, str(o.hint));
  }
  return unwrap(json) as unknown as T;
}

/** Media URL for <audio>/<img>. The app embeds the same HTTP file server, so both runtimes use it. */
export function fileUrl(path: string): string {
  return `${HTTP_BASE}/f?path=${encodeURIComponent(path)}`;
}

/** 42.3 -> "0:42.3", 65 -> "1:05" */
export function fmtTime(sec: number): string {
  const r = Math.round((isFinite(sec) && sec > 0 ? sec : 0) * 10) / 10;
  const m = Math.floor(r / 60);
  const s = Math.round((r - m * 60) * 10) / 10;
  const txt =
    s % 1 === 0
      ? String(Math.round(s)).padStart(2, '0')
      : s.toFixed(1).padStart(4, '0');
  return `${m}:${txt}`;
}

export function baseName(p: string): string {
  const clean = String(p || '').replace(/[\\/]+$/, '');
  const parts = clean.split(/[\\/]/);
  const last = parts[parts.length - 1] || clean || '音频';
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(0, dot) : last;
}

export function extOf(p: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(String(p || ''));
  return m ? m[1].toLowerCase() : '';
}
