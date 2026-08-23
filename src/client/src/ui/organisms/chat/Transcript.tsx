// Transcript rendering: one row per turn, and the ordered segments inside an assistant turn.
//
// `TranscriptRow` is memoised on purpose — without it every streamed delta re-parses the markdown of
// every earlier row in the conversation.
import { memo } from 'react';
import { ToolOutlined } from '@ant-design/icons';
import { MarkdownView } from '../MarkdownView';
import { BlockSegment } from '@/ui/blocks/BlockSegment';
import type { Segment, TranscriptItem } from './chatReducer';

export function SegmentList({
  segments, onSend, onOpenRecord
}: {
  segments: Segment[];
  onSend?: (text: string) => void;
  onOpenRecord?: (path: string) => void;
}) {
  return (
    <>
      {segments.map((seg) =>
        seg.kind === 'prose' ? (
          <MarkdownView key={seg.index} source={seg.text} />
        ) : (
          <BlockSegment key={seg.index} block={seg.block} onSend={onSend} onOpenRecord={onOpenRecord} />
        )
      )}
    </>
  );
}

// Memoized: a chat turn streams many `text-delta` events; each re-renders
// ChatPanel. Without memo, every finished message (each a MarkdownView) would
// re-parse its markdown on every delta. `item` is referentially stable per id,
// so finished rows stay static and only the live streaming block re-renders.
// `onSend`/`onOpenRecord` must be STABLE refs from ChatPanel or this memo is defeated.
export const TranscriptRow = memo(function TranscriptRow({
  item, onSend, onOpenRecord
}: {
  item: TranscriptItem;
  onSend?: (text: string) => void;
  onOpenRecord?: (path: string) => void;
}) {
  if (item.role === 'divider') {
    return <div className="chat-divider" aria-hidden />;
  }
  if (item.role === 'user') {
    return <div className="chat-msg user">{item.text}</div>;
  }
  if (item.role === 'assistant') {
    return (
      <div className="chat-msg assistant">
        <SegmentList segments={item.segments ?? []} onSend={onSend} onOpenRecord={onOpenRecord} />
      </div>
    );
  }
  if (item.role === 'tool') {
    return (
      <div className="chat-tool">
        <ToolOutlined />
        <span className="chat-tool-name">{item.tool?.name}</span>
        {item.tool?.detail && <span className="chat-tool-detail">{item.tool.detail}</span>}
      </div>
    );
  }
  // notice
  return <div className="chat-notice">{item.text}</div>;
});
