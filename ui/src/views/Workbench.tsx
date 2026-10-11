import { Editor } from '../components/Editor';
import { Header } from '../components/Header';
import { Transcript } from '../components/Transcript';
import { LevelsCard } from '../components/LevelsCard';
import { RenderCard } from '../components/RenderCard';
import { ScoreCard, SectionsCard } from '../components/AnalysisCards';
import { Card } from '../components/ui';

export function Workbench() {
  return (
    <div className="wb">
      <Header />
      <div className="row2">
        <Editor />
        <Card title="文稿" className="side">
          <Transcript />
        </Card>
      </div>
      <div className="row4">
        <Card title="音频评分">
          <ScoreCard />
        </Card>
        <Card title="响度与电平">
          <LevelsCard />
        </Card>
        <Card title="段落">
          <SectionsCard />
        </Card>
        <Card title="渲染导出">
          <RenderCard />
        </Card>
      </div>
    </div>
  );
}
