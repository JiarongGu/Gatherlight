import type { ReactNode } from 'react';
import {
  Button,
  Tag,
  Switch,
  Alert,
  IconButton,
  CatBadge,
  StatusBadge,
  Kbd,
  DayChip,
  DiffBlock,
  Highlight,
  Stepper
} from '@/ui/atoms';
import {
  Carousel, Collapsible, ModelPullField, PullProgress, ResourceRow, Segmented, SnippetText,
} from '@/ui/molecules';
import { RobotOutlined, DeleteOutlined } from '@ant-design/icons';

// Each atom in its own anchored block, shown in dark + light side by side, so a
// single atom is verifiable at /?gallery#g-<Name> (the UI agent's check surface).
//
// MOLECULES ARE HERE TOO, and the reason is a bug this surface should have caught. The console's
// molecules were built and reviewed only in dark, and a light-theme pass later found real defects in
// them — an unusable state rendered as the LOUDEST thing on the row. Side-by-side is the check; a
// component that is not on this page does not get it. So a molecule with STATES shows its states:
// Segmented's `na`, ResourceRow's installed/failed/progress, PullProgress's three outcomes. A state
// that only appears when a download fails is otherwise seen for the first time when one does.

// `stack` because the pane is a wrapping flex ROW, which is right for atoms (a handful of chips or
// buttons in a line) and wrong for anything full-width. Three PullProgress bars laid out as a row
// crushed each other into unreadable slivers — caught the first time this page rendered them, which is
// the argument for the page.
function Item({ name, stack, children }: { name: string; stack?: boolean; children: ReactNode }) {
  const pane = `g-pane${stack ? ' g-stack' : ''}`;
  return (
    <section id={`g-${name}`} className="g-item">
      <h3 className="g-name">{name}</h3>
      <div className="g-panes">
        <div className={pane} data-theme="dark">{children}</div>
        <div className={pane} data-theme="light">{children}</div>
      </div>
    </section>
  );
}

const SAMPLE_DIFF = `@@ -1,2 +1,2 @@
-old line
+new line
 context line`;

export function Gallery() {
  return (
    <div className="gallery-page">
      <h1>组件画廊 · L1 visual</h1>
      <p className="g-hint">每个原子与分子在 暗/亮 两个主题下并排展示。锚点:<code>/?gallery#g-Segmented</code></p>

      <h2 className="g-tier">原子 · Atoms</h2>

      <Item name="Button">
        <Button type="primary">主要</Button> <Button>默认</Button> <Button danger>危险</Button>
      </Item>
      <Item name="IconButton">
        <IconButton icon={<RobotOutlined />} title="助手" />
        <IconButton icon={<DeleteOutlined />} title="删除" danger />
      </Item>
      <Item name="Tag">
        <Tag color="processing">处理中</Tag> <Tag color="green">绿</Tag> <Tag>默认</Tag>
      </Item>
      <Item name="Switch">
        <Switch defaultChecked /> <Switch />
      </Item>
      <Item name="Alert">
        <Alert type="success" showIcon message="构建通过 ✓" />
      </Item>
      <Item name="CatBadge">
        <CatBadge label="旅游" /> <CatBadge label="预算" />
      </Item>
      <Item name="StatusBadge">
        <StatusBadge status="upcoming" text="还有 54 天" />{' '}
        <StatusBadge status="ongoing" text="进行中" /> <StatusBadge status="past" text="已结束" />
      </Item>
      <Item name="Kbd">
        <Kbd>⌘K</Kbd> <Kbd>Esc</Kbd>
      </Item>
      <Item name="DayChip">
        <DayChip n={1} date="9·5" weekday="六" />
        <DayChip n={2} date="9·6" weekday="日" active />
        <DayChip n={3} />
      </Item>
      <Item name="Carousel">
        <Carousel ariaLabel="demo">
          {Array.from({ length: 12 }, (_, i) => (
            <DayChip key={i} n={i + 1} date={`9·${i + 5}`} active={i === 2} />
          ))}
        </Carousel>
      </Item>
      <Item name="DiffBlock" stack>
        <DiffBlock diff={SAMPLE_DIFF} />
      </Item>
      <Item name="Highlight">
        <div>
          搜索结果:<Highlight text="日本关西行程 9 月" start={2} end={4} />
        </div>
      </Item>
      <Item name="Stepper" stack>
        <Stepper
          steps={[
            { key: '1', label: '计划' },
            { key: '2', label: '审计划' },
            { key: '3', label: '执行' },
            { key: '4', label: '审改动' },
            { key: '5', label: '提交' }
          ]}
          current={2}
        />
      </Item>

      <h2 className="g-tier">分子 · Molecules</h2>

      {/* The `na` option is the one to look at: dimmed and dashed, and still PRESSABLE, because
          pressing it is how a household reads why the option is unavailable. If it ever reads as the
          loudest thing in the row — which is exactly what happened in light theme once — that is the
          defect, and this is where it is visible without setting up a machine that can reproduce it. */}
      <Item name="Segmented">
        <Segmented
          value="b"
          onSelect={() => {}}
          options={[
            { value: 'a', label: 'Claude CLI' },
            { value: 'b', label: '本机 · Ollama' },
            { value: 'c', label: '其他本机服务' },
            { value: 'd', label: '内置(随应用附带)', available: false },
          ]}
        />
      </Item>

      <Item name="ResourceRow" stack>
        <ResourceRow
          name={<>Git 版本管理<code> (2.55.0.2)</code></>}
          badges={<span className="res-badge">已安装</span>}
          installed
          approxBytes={39_000_000}
          lines="数据仓库的引擎(改动审计 + 历史记录)"
          action={<button className="cx-btn">重新下载</button>}
        />
        <ResourceRow
          name="Ollama 本地模型运行时"
          failed
          problem="未在运行 —— 启动它,或改用其他后端。"
          approxBytes={1_500_000_000}
          action={<button className="cx-btn primary">启动</button>}
        />
        <ResourceRow
          name="嵌入模型 · EmbeddingGemma-300M"
          progress={{ percent: 46, message: '正在下载 model_q4.onnx…' }}
          approxBytes={222_000_000}
        />
      </Item>

      {/* Three outcomes, because the middle one is the whole point: a null percent renders as
          INDETERMINATE rather than a bar pinned at 0%, which reads as stuck. */}
      <Item name="PullProgress" stack>
        <PullProgress pull={{ model: 'granite-embedding:278m', running: true, percent: 62, status: '下载中', error: null }} />
        <PullProgress pull={{ model: 'nomic-embed-text', running: true, percent: null, status: '正在解析清单…', error: null }} />
        <PullProgress pull={{ model: 'bge-m3', running: false, percent: null, status: null, error: '拉取失败:磁盘空间不足' }} />
      </Item>

      <Item name="ModelPullField" stack>
        <ModelPullField
          busy={null}
          pullOf={() => null}
          onPull={() => {}}
          label="其他模型"
          placeholder="如 nomic-embed-text"
          hint="任何 Ollama 上的嵌入模型都可以填在这里。"
        />
      </Item>

      <Item name="Collapsible" stack>
        <Collapsible summary="展开看细节">
          <div style={{ padding: '6px 0' }}>折叠区域的内容。</div>
        </Collapsible>
      </Item>

      <Item name="SnippetText" stack>
        <SnippetText snippet={{ text: '日本关西行程 9 月 · 大阪 → 京都', matchStart: 2, matchEnd: 4 }} />
      </Item>
    </div>
  );
}
