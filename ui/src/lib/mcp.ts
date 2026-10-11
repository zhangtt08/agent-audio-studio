import type { CapsRes } from '../types';

/** Ready-to-paste MCP snippet built only from `caps`. */
export function mcpSnippet(caps: CapsRes | null): string {
  const cmd = caps?.mcp?.cmd || 'agentaudio';
  const args = Array.isArray(caps?.mcp?.args) ? caps!.mcp.args.map(String) : ['mcp'];
  return JSON.stringify({ mcpServers: { agentaudio: { command: cmd, args } } }, null, 2);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
