// Import primitives from @/ui/atoms, NEVER from antd directly — src/client/src/ui/atoms/primitives.ts
// states the rule (molecules/organisms/screens go through the kit so it stays swappable).
import { Spin, Collapse } from '@/ui/atoms';
import { UiTree } from './UiTree';
import type { UiBlockEvent } from '@/lib/chatTypes';

/**
 * A block that failed validation is SHOWN, not dropped: a silent hole makes a schema bug invisible
 * and leaves the user reading a reply with a gap in it. It is also not a red error — a household
 * seeing an alarm for a block name we simply do not ship is a support call, not a signal.
 */
export function BlockSegment({
  block, onSend, onOpenRecord,
}: { block: UiBlockEvent; onSend?: (t: string) => void; onOpenRecord?: (p: string) => void }) {
  if (block.status === 'partial') {
    return (
      <div className="ui-block-partial">
        <Spin size="small" /> <span>正在准备视图… · Preparing view…</span>
      </div>
    );
  }
  if (block.status === 'invalid') {
    return (
      <div className="ui-block-fallback">
        <div className="ui-block-fallback-head">这段内容暂时无法显示 · This content could not be displayed</div>
        {block.reason ? <div className="ui-block-fallback-reason">{block.reason}</div> : null}
        <Collapse
          ghost
          size="small"
          items={[{ key: 'raw', label: '查看原始内容 · Show raw content', children: <pre>{block.raw ?? ''}</pre> }]}
        />
      </div>
    );
  }
  return block.node
    ? <UiTree node={block.node} onSend={onSend} onOpenRecord={onOpenRecord} />
    : null;
}
