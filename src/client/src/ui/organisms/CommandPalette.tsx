import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Input } from '@/ui/atoms';
import {
  SearchOutlined,
  FileTextOutlined,
  HomeOutlined,
  RobotOutlined,
  EnterOutlined
} from '@ant-design/icons';
import type { PlanFile } from '@/lib/collectFiles';
import { extractSnippet, type Snippet } from '@/lib/markdown';
import { getRecent } from '@/lib/recentFiles';
import { CATEGORY_LABEL } from '@/lib/categories';

interface Props {
  open: boolean;
  files: PlanFile[];
  onClose: () => void;
  onSelect: (path: string) => void;
  onGoHome: () => void;
  onOpenChat: () => void;
}

type Row =
  | { kind: 'action'; id: string; label: string; icon: React.ReactNode; run: () => void }
  | { kind: 'file'; id: string; file: PlanFile; snippet: Snippet | null };

interface Group {
  label: string;
  rows: Row[];
}

const MAX_RESULTS = 40;

export function CommandPalette({ open, files, onClose, onSelect, onGoHome, onOpenChat }: Props) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset on open.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);

  const byPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files]);

  // Pre-lowercase each file's name/title/content ONCE so every keystroke filters
  // against a ready haystack instead of re-running toLowerCase() over dozens of
  // full documents. Deferring the query keeps typing responsive while the heavy
  // content scan runs at lower priority.
  const searchIndex = useMemo(
    () =>
      files.map((f) => ({
        file: f,
        hayName: f.name.toLowerCase(),
        hayTitle: f.title.toLowerCase(),
        hayContent: f.content.toLowerCase()
      })),
    [files]
  );
  const deferredQuery = useDeferredValue(query);

  const actionRows: Row[] = useMemo(
    () => [
      { kind: 'action', id: 'act-home', label: '回到首页', icon: <HomeOutlined />, run: onGoHome },
      { kind: 'action', id: 'act-chat', label: '打开 Claude 助手', icon: <RobotOutlined />, run: onOpenChat }
    ],
    [onGoHome, onOpenChat]
  );

  const { groups, flatRows } = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();

    if (!q) {
      const recent = getRecent()
        .map((p) => byPath.get(p))
        .filter((f): f is PlanFile => !!f)
        .map<Row>((f) => ({ kind: 'file', id: f.path, file: f, snippet: null }));
      const gs: Group[] = [];
      if (recent.length) gs.push({ label: '最近查看', rows: recent });
      gs.push({ label: '操作', rows: actionRows });
      return { groups: gs, flatRows: gs.flatMap((g) => g.rows) };
    }

    const matched = searchIndex
      .filter((e) => e.hayName.includes(q) || e.hayTitle.includes(q) || e.hayContent.includes(q))
      .map((e) => e.file);
    // Rank: title/name matches before content-only matches.
    const nameOrTitleHit = (f: PlanFile) =>
      f.title.toLowerCase().includes(q) || f.name.toLowerCase().includes(q);
    matched.sort((a, b) => (nameOrTitleHit(a) ? 0 : 1) - (nameOrTitleHit(b) ? 0 : 1));
    const limited = matched.slice(0, MAX_RESULTS);

    const byCat = new Map<string, Row[]>();
    for (const f of limited) {
      const list = byCat.get(f.category) ?? [];
      list.push({ kind: 'file', id: f.path, file: f, snippet: extractSnippet(f.content, deferredQuery) });
      byCat.set(f.category, list);
    }
    const gs: Group[] = [...byCat.entries()].map(([cat, rows]) => ({
      label: CATEGORY_LABEL[cat] ?? cat,
      rows
    }));
    return { groups: gs, flatRows: gs.flatMap((g) => g.rows) };
  }, [deferredQuery, searchIndex, byPath, actionRows]);

  // Keep active index in range.
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, flatRows.length - 1)));
  }, [flatRows.length]);

  // Scroll active row into view.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function runRow(row: Row) {
    if (row.kind === 'action') row.run();
    else onSelect(row.file.path);
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, flatRows.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = flatRows[active];
      if (row) runRow(row);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  let rowIndex = -1;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      closable={false}
      width={640}
      style={{ top: 72 }}
      className="cmdk-modal"
      styles={{ body: { padding: 0 } }}
      destroyOnClose
    >
      <div className="cmdk">
        <div className="cmdk-input">
          <SearchOutlined style={{ color: 'var(--muted)', fontSize: 16 }} />
          <Input
            variant="borderless"
            autoFocus
            placeholder="搜索全部计划:文件名 / 标题 / 内容…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd className="cmdk-esc">Esc</kbd>
        </div>

        <div className="cmdk-list" ref={listRef}>
          {flatRows.length === 0 ? (
            <div className="cmdk-empty">没有匹配的内容</div>
          ) : (
            groups.map((g) => (
              <div key={g.label} className="cmdk-group">
                <div className="cmdk-group-label">{g.label}</div>
                {g.rows.map((row) => {
                  rowIndex += 1;
                  const isActive = rowIndex === active;
                  const idx = rowIndex;
                  return (
                    <div
                      key={row.id}
                      data-active={isActive}
                      className={`cmdk-row ${isActive ? 'active' : ''}`}
                      onMouseEnter={() => setActive(idx)}
                      onClick={() => runRow(row)}
                    >
                      {row.kind === 'action' ? (
                        <>
                          <span className="cmdk-row-icon">{row.icon}</span>
                          <span className="cmdk-row-title">{row.label}</span>
                        </>
                      ) : (
                        <>
                          <span className="cmdk-row-icon">
                            <FileTextOutlined />
                          </span>
                          <div className="cmdk-row-main">
                            <div className="cmdk-row-title">{row.file.title}</div>
                            <div className="cmdk-row-path">{row.file.path}</div>
                            {row.snippet && <SnippetText snippet={row.snippet} />}
                          </div>
                        </>
                      )}
                      {isActive && <EnterOutlined className="cmdk-row-enter" />}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="cmdk-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
          <span><kbd>↵</kbd> 打开</span>
          <span><kbd>Esc</kbd> 关闭</span>
        </div>
      </div>
    </Modal>
  );
}

function SnippetText({ snippet }: { snippet: Snippet }) {
  return (
    <div className="cmdk-snippet">
      {snippet.text.slice(0, snippet.matchStart)}
      <mark>{snippet.text.slice(snippet.matchStart, snippet.matchEnd)}</mark>
      {snippet.text.slice(snippet.matchEnd)}
    </div>
  );
}
