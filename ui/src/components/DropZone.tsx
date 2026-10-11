import { useState } from 'react';
import { useApp } from '../state/app';
import { Btn } from './ui';
import { Icon } from './Icon';

export function DropZone() {
  const { addPaths, pickFiles } = useApp();
  const [over, setOver] = useState(false);

  const take = (list: FileList | null) => {
    if (!list || !list.length) return;
    const paths = Array.from(list).map((f) => {
      const anyFile = f as File & { path?: string };
      return anyFile.path || f.name;
    });
    void addPaths(paths);
  };

  return (
    <div
      className={`drop${over ? ' is-over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        take(e.dataTransfer?.files ?? null);
      }}
    >
      <Icon n="import" s={22} />
      <p>拖入音频或视频</p>
      <Btn tone="primary" onClick={pickFiles}>
        选择文件
      </Btn>
    </div>
  );
}
