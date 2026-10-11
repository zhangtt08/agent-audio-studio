import { useEffect } from 'react';
import { isTauri } from './api';
import { AppProvider, useApp } from './state/app';
import { Rail } from './components/Rail';
import { TitleBar } from './components/TitleBar';
import { Icon } from './components/Icon';
import { Workbench } from './views/Workbench';
import { TracksView } from './views/Tracks';
import { AgentsView } from './views/Agents';
import { SettingsView } from './views/Settings';

function pathOf(f: File): string {
  const withPath = f as File & { path?: string };
  return withPath.path || f.name;
}

function Shell() {
  const { view, addPaths, doctor, offline, note, clearNote, setSubsFromText, reconnect } = useApp();

  useEffect(() => {
    if (!isTauri) return;
    let un: (() => void) | null = null;
    let dead = false;
    void (async () => {
      try {
        const mod = await import('@tauri-apps/api/webviewWindow');
        const win = mod.getCurrentWebviewWindow();
        const off = await win.onDragDropEvent((e) => {
          if (e.payload.type === 'drop' && e.payload.paths.length) void addPaths(e.payload.paths);
        });
        if (dead) off();
        else un = off;
      } catch {
        /* onDragDropEvent unavailable */
      }
    })();
    return () => {
      dead = true;
      if (un) un();
    };
  }, [addPaths]);

  useEffect(() => {
    if (!note) return;
    const t = window.setTimeout(() => clearNote(), 8000);
    return () => window.clearTimeout(t);
  }, [note, clearNote]);

  const onMedia = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.currentTarget.files ?? []);
    e.currentTarget.value = '';
    if (!files.length) return;
    const subs = files.filter((f) => /\.(srt|vtt)$/i.test(f.name));
    const media = files.filter((f) => !/\.(srt|vtt)$/i.test(f.name));
    for (const s of subs) {
      const rd = new FileReader();
      rd.onload = () => setSubsFromText(String(rd.result ?? ''), s.name);
      rd.readAsText(s);
    }
    if (media.length) void addPaths(media.map(pathOf));
  };

  const onSub = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = (e.currentTarget.files ?? [])[0];
    e.currentTarget.value = '';
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => setSubsFromText(String(rd.result ?? ''), f.name);
    rd.readAsText(f);
  };

  const banner = !offline && doctor && !doctor.ok;

  return (
    <div className="app">
      <Rail />
      <main
        className="main"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const files = Array.from(e.dataTransfer?.files ?? []);
          if (!files.length) return;
          const subs = files.filter((f) => /\.(srt|vtt)$/i.test(f.name));
          const media = files.filter((f) => !/\.(srt|vtt)$/i.test(f.name));
          for (const s of subs) {
            const rd = new FileReader();
            rd.onload = () => setSubsFromText(String(rd.result ?? ''), s.name);
            rd.readAsText(s);
          }
          if (media.length) void addPaths(media.map(pathOf));
        }}
      >
        <TitleBar />
        {banner ? (
          <div className="banner">
            <Icon n="power" s={15} />
            <b>ffmpeg 未找到</b>
            <em>{doctor?.ffmpeg || '设置 · ffmpeg 路径'}</em>
            <button type="button" onClick={() => void reconnect()}>
              重新检测
            </button>
          </div>
        ) : null}

        {view === 'workbench' ? <Workbench /> : null}
        {view === 'tracks' ? <TracksView /> : null}
        {view === 'agent' ? <AgentsView /> : null}
        {view === 'settings' ? <SettingsView /> : null}

        {note ? (
          <div className={`note note-${note.kind}`}>
            <Icon n={note.kind === 'err' ? 'close' : 'check'} s={13} />
            <span>{note.text}</span>
            <button type="button" onClick={() => clearNote()} title="关闭">
              <Icon n="close" s={12} />
            </button>
          </div>
        ) : null}

        <input id="aa-file-input" type="file" multiple accept="audio/*,video/*,.srt,.vtt" hidden onChange={onMedia} />
        <input id="aa-sub-input" type="file" accept=".srt,.vtt" hidden onChange={onSub} />
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
