import { Btn, Card, Field } from '../components/ui';
import { isTauri, rpc } from '../api';
import { useApp } from '../state/app';

const FMTS = ['wav', 'flac', 'mp3', 'opus', 'aac'];
const SRS = [44100, 48000, 88200, 96000];
const CHS: [number, string][] = [
  [1, '单声道'],
  [2, '立体声'],
  [6, '5.1'],
];

export function SettingsView() {
  const { prefs, setPrefs, doctor, caps, offline, reconnect, actions, projectName, setProjectName, saveProject } =
    useApp();

  const pickDir = async () => {
    if (!isTauri) return;
    try {
      const mod = await import('@tauri-apps/plugin-dialog');
      const dir = await mod.open({ directory: true });
      if (typeof dir === 'string') setPrefs({ outDir: dir });
    } catch {
      /* dialog unavailable */
    }
  };

  return (
    <div className="sv">
      <div className="av-head">
        <h2>设置</h2>
        <p className="tag">写入项目文件 · 智能体读取同一份</p>
      </div>

      <div className="row2a">
        <Card title="输出">
          <div className="fgrid">
            <Field label="格式">
              <select value={prefs.fmt} onChange={(e) => setPrefs({ fmt: e.currentTarget.value })}>
                {FMTS.map((f) => (
                  <option key={f} value={f}>
                    {f.toUpperCase()}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="采样率">
              <select value={prefs.sr} onChange={(e) => setPrefs({ sr: Number(e.currentTarget.value) })}>
                {SRS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="声道">
              <select value={prefs.ch} onChange={(e) => setPrefs({ ch: Number(e.currentTarget.value) })}>
                {CHS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="目标响度 LUFS">
              <input
                type="number"
                min={-40}
                max={0}
                step={0.5}
                value={prefs.target}
                onChange={(e) => setPrefs({ target: Number(e.currentTarget.value) })}
              />
            </Field>
            <label className="check">
              <input
                type="checkbox"
                checked={prefs.normalize}
                onChange={(e) => setPrefs({ normalize: e.currentTarget.checked })}
              />
              <span>导出前归一</span>
            </label>
          </div>
          <Field label="输出目录">
            <div className="row-in">
              <input
                type="text"
                value={prefs.outDir}
                placeholder="默认工作目录"
                onChange={(e) => setPrefs({ outDir: e.currentTarget.value })}
              />
              {isTauri ? (
                <Btn size="sm" icon="folder" onClick={() => void pickDir()}>
                  选择
                </Btn>
              ) : null}
              {prefs.outDir ? (
                <Btn size="sm" icon="close" onClick={() => setPrefs({ outDir: '' })} title="清除" />
              ) : null}
            </div>
          </Field>
        </Card>

        <Card title="运行时">
          <div className="fgrid">
            <Field label="ffmpeg 路径">
              <input
                type="text"
                value={prefs.ffmpeg}
                placeholder={doctor?.ffmpeg || '自动查找'}
                onChange={(e) => setPrefs({ ffmpeg: e.currentTarget.value })}
              />
            </Field>
            <Field label="主题">
              <select
                value={prefs.theme}
                onChange={(e) => setPrefs({ theme: e.currentTarget.value === 'dark' ? 'dark' : 'light' })}
              >
                <option value="light">浅色</option>
                <option value="dark">深色</option>
              </select>
            </Field>
            <Field label="项目">
              <div className="row-in">
                <input type="text" value={projectName} onChange={(e) => setProjectName(e.currentTarget.value)} />
                <Btn size="sm" icon="save" onClick={() => void saveProject()}>
                  保存
                </Btn>
              </div>
            </Field>
          </div>
          <div className="dr">
            <span>ffmpeg</span>
            <b className="mono">{doctor?.ver || doctor?.ffmpeg || (offline ? '未连接' : '未检测到')}</b>
          </div>
          <div className="dr">
            <span>后端</span>
            <b className="mono">{caps?.v ? `v${caps.v}` : offline ? '未连接' : '—'}</b>
          </div>
          <div className="dr">
            <span>工作目录</span>
            <b className="mono ell">{doctor?.home || caps?.dir || '—'}</b>
          </div>
          <div className="sv-act">
            <Btn size="sm" icon="refresh" onClick={() => void reconnect()}>
              重新检测
            </Btn>
            <Btn size="sm" icon="wave" onClick={() => void actions.samples()}>
              生成示例
            </Btn>
          </div>
        </Card>
      </div>

      <Card title="调用">
        <div className="fgrid">
          <Field label="RPC 端点">
            <div className="row-in">
              <input type="text" readOnly value={isTauri ? "invoke('rpc')" : 'POST /api/<method>'} />
              <Btn
                size="sm"
                icon={offline ? 'close' : 'check'}
                onClick={() => void rpc('doctor').then(() => reconnect()).catch(() => reconnect())}
              >
                {offline ? '未连接' : '已连接'}
              </Btn>
            </div>
          </Field>
        </div>
      </Card>
    </div>
  );
}
