import { HTTP_BASE } from '../api';
import { AgentStatus, ConnState, McpCopy } from '../components/AgentStatus';
import { Icon } from '../components/Icon';
import { Btn, Card, Empty } from '../components/ui';
import { fmtClock } from '../lib/units';
import { mcpSnippet } from '../lib/mcp';
import { useApp } from '../state/app';

function KV({ k, v, mono = false }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="kv">
      <span>{k}</span>
      <b className={mono ? 'mono' : ''}>{v || '—'}</b>
    </div>
  );
}

export function AgentsView() {
  const app = useApp();
  const { calls, callsTotal, caps, doctor, offline, jobs, refreshCalls, setView } = app;
  const ok = calls.filter((c) => c.ok).length;
  const running = jobs.filter((j) => j.state === 'running').length;

  return (
    <div className="av">
      <div className="av-head">
        <h2>智能体</h2>
        <p className="tag">同一引擎的调用面 · MCP / HTTP</p>
      </div>

      <div className="row2a">
        <Card title="连接" right={<ConnState app={app} />}>
          {offline ? (
            <Empty text={`后端未连接 · ${HTTP_BASE}`} />
          ) : (
            <div className="kvs">
              <KV k="HTTP" v={`${HTTP_BASE}/api/<method}`} mono />
              <KV k="端口" v={String(caps?.http?.port ?? '—')} />
              <KV k="版本" v={caps?.v ?? '—'} />
              <KV k="工作目录" v={caps?.dir ?? doctor?.home ?? '—'} mono />
              <KV k="输出目录" v={doctor?.out ?? '—'} mono />
              <KV k="ffmpeg" v={doctor?.ffmpeg || doctor?.ver || '—'} mono />
            </div>
          )}
          <div className="av-act">
            <Btn size="sm" icon="refresh" onClick={() => void refreshCalls()}>
              刷新
            </Btn>
            <Btn size="sm" icon="settings" onClick={() => setView('settings')}>
              设置
            </Btn>
          </div>
        </Card>

        <Card title="概览">
          <div className="stats">
            <div className="stat">
              <b>{callsTotal}</b>
              <span>调用总数</span>
            </div>
            <div className="stat">
              <b>
                {ok}/{calls.length}
              </b>
              <span>成功</span>
            </div>
            <div className="stat">
              <b>{running}</b>
              <span>运行中</span>
            </div>
            <div className="stat">
              <b>{caps?.tools?.length ?? 0}</b>
              <span>工具</span>
            </div>
          </div>
          <div className="astat-slot">
            <AgentStatus />
          </div>
        </Card>
      </div>

      <Card
        title="调用记录"
        right={
          <span className="meta">
            {calls.length ? `最近 ${calls.length} 条` : ''}
          </span>
        }
      >
        {calls.length === 0 ? (
          <Empty text={offline ? '后端未连接' : '暂无记录'} />
        ) : (
          <div className="scroll table">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>op</th>
                  <th>状态</th>
                  <th>ms</th>
                  <th>输入</th>
                  <th>输出</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((c, i) => (
                  <tr key={`${c.t}-${i}`} className={c.ok ? '' : 'bad'}>
                    <td className="mono">{fmtClock(c.ts)}</td>
                    <td>{c.op}</td>
                    <td>
                      <span className={`tagst ${c.ok ? 'ok' : 'no'}`}>
                        <Icon n={c.ok ? 'check' : 'close'} s={12} />
                        {c.ok ? '完成' : '失败'}
                      </span>
                    </td>
                    <td className="mono">{Math.round(c.ms)}</td>
                    <td className="mono ell">{c.inp}</td>
                    <td className="mono ell">
                      {c.e ? <span className="err">{c.e}</span> : c.out}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="row2a">
        <Card title="MCP 配置" right={<McpCopy size="md" />}>
          <pre className="code">{mcpSnippet(caps)}</pre>
        </Card>
        <Card title="工具">
          {caps ? (
            <div className="scroll toollist">
              {caps.tools.map((t) => (
                <div className="tool" key={t.n}>
                  <b className="mono">{t.n}</b>
                  <span>{t.d}</span>
                </div>
              ))}
              {caps.ops.map((o) => (
                <div className="tool" key={o.k}>
                  <b className="mono">{o.k}</b>
                  <span>{o.d}</span>
                </div>
              ))}
              {caps.presets.map((p) => (
                <div className="tool" key={p.n}>
                  <b className="mono">{p.n}</b>
                  <span>{p.d}</span>
                </div>
              ))}
              {!caps.tools.length && !caps.ops.length && !caps.presets.length ? <Empty text="暂无记录" /> : null}
            </div>
          ) : (
            <Empty text="后端未连接" />
          )}
        </Card>
      </div>
    </div>
  );
}
