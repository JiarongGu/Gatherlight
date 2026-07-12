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
} from '@/shared/components/visual';
import { Carousel } from '@/shared/components/configured';
import { RobotOutlined, DeleteOutlined } from '@ant-design/icons';

// Each atom in its own anchored block, shown in dark + light side by side, so a
// single atom is verifiable at /?gallery#g-<Name> (the UI agent's check surface).
function Item({ name, children }: { name: string; children: ReactNode }) {
  return (
    <section id={`g-${name}`} className="g-item">
      <h3 className="g-name">{name}</h3>
      <div className="g-panes">
        <div className="g-pane" data-theme="dark">{children}</div>
        <div className="g-pane" data-theme="light">{children}</div>
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
      <p className="g-hint">每个原子在 暗/亮 两个主题下展示。锚点:<code>/?gallery#g-DayChip</code></p>

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
      <Item name="DiffBlock">
        <DiffBlock diff={SAMPLE_DIFF} />
      </Item>
      <Item name="Highlight">
        <div>
          搜索结果:<Highlight text="日本关西行程 9 月" start={2} end={4} />
        </div>
      </Item>
      <Item name="Stepper">
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
    </div>
  );
}
