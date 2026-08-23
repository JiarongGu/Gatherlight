import { Tag, Spin } from '@/ui/atoms';
import type { ConversationRow } from '@/lib/chatApi';

const PHASE_CHIP: Record<string, { label: string; color: string }> = {
  committed: { label: '已提交', color: 'green' },
  rejected: { label: '已撤销', color: 'default' },
  cancelled: { label: '已停止', color: 'default' },
  error: { label: '出错', color: 'red' },
};

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString([], { month: '2-digit', day: '2-digit' });
};

/** The conversation list. Titles come from the first user message, so there is nothing to name and
 *  nothing to keep in sync — a conversation is findable by what it was about. */
export function ChatHistory({
  rows, loading, activeId, onOpen,
}: {
  rows: ConversationRow[];
  loading: boolean;
  activeId: string | null;
  onOpen: (id: string) => void;
}) {
  if (loading) return <div className="chat-history-empty"><Spin size="small" /></div>;
  if (rows.length === 0) return <div className="chat-history-empty">还没有对话记录。</div>;

  return (
    <div className="chat-history">
      {rows.map((r) => {
        const chip = PHASE_CHIP[r.phase];
        return (
          <button
            key={r.id}
            type="button"
            className={`chat-history-row${r.id === activeId ? ' is-active' : ''}`}
            onClick={() => onOpen(r.id)}
          >
            <span className="chat-history-title">{r.title}</span>
            <span className="chat-history-meta">
              {when(r.createdAt)}
              {r.turns > 1 ? ` · ${r.turns} 轮` : ''}
              {chip ? <Tag color={chip.color}>{chip.label}</Tag> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
