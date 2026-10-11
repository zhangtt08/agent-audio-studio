import { copyText, mcpSnippet } from '../lib/mcp';
import { useApp, type Ctx } from '../state/app';
import { Btn, Empty } from './ui';

export function ConnState({ app }: { app: Ctx }) {
  const up = !app.offline && (app.caps?.http?.up ?? false);
  const label = app.offline ? '离线' : up ? '在线' : '待启动';
  const color = app.offline ? '#8A8682' : up ? '#22C55E' : '#F5A623';
  return (
    <span className="conn">
      <i style={{ background: color }} />
      {label}
    </span>
  );
}

export function McpCopy({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  const { caps, notify } = useApp();
  return (
    <Btn
      size={size}
      icon="copy"
      onClick={async () => {
        const ok = await copyText(mcpSnippet(caps));
        notify(ok ? 'ok' : 'err', ok ? 'MCP 配置已复制' : '复制失败');
      }}
    >
      复制 MCP 配置
    </Btn>
  );
}

export function AgentStatus() {
  const app = useApp();
  const { calls, callsTotal, offline, caps } = app;
  const port = caps?.http?.port ?? 8787;
  return (
    <div className="astat">
      <div className="astat-h">
        <span className="astat-t">智能体</span>
        <ConnState app={app} />
      </div>
      {calls.length === 0 ? (
        <div className="astat-e">
          <Empty text={offline ? '后端未连接' : '等待智能体调用'} />
          <McpCopy />
        </div>
      ) : (
        <>
          <ul className="acalls">
            {calls.slice(0, 3).map((c, i) => (
              <li key={`${c.t}-${i}`} className={c.ok ? 'ok' : 'bad'}>
                <b>{c.op}</b>
                <span>{c.ok ? '完成' : '失败'}</span>
                <i>{Math.round(c.ms)}ms</i>
              </li>
            ))}
          </ul>
          <div className="astat-f">
            <span>共 {callsTotal} 次</span>
            <span className="meta">{`127.0.0.1:${port}`}</span>
          </div>
        </>
      )}
    </div>
  );
}
