import { useMemo, useState } from 'react';
import {
  SearchOutlined,
  CodeOutlined,
  FileTextOutlined,
  ApartmentOutlined,
  BookOutlined,
  CheckCircleOutlined,
  ToolOutlined
} from '@ant-design/icons';
import type { PlanFile } from '@/lib/collectFiles';
import { CATEGORY_LABEL } from '@/lib/categories';
import { toPlainText } from '@/lib/markdown';

// The 智库 — the AI's own infrastructure (rules / skills / workflows / templates / indices). A
// STANDALONE surface, parallel to the 知识库 Library, pulled out of the growing plan tree: the plan
// menus grow with the user's trips, this set is a fixed corpus the planner agent runs on. Celadon
// accent (the design system's calm secondary) sets it apart from the amber Library.
const KB_CATEGORIES = ['Rules', 'Skills', 'Workflows', 'Templates', 'Index', 'Dev'];
const KB_ICON: Record<string, React.ReactNode> = {
  Dev: <CodeOutlined />,
  Templates: <FileTextOutlined />,
  Workflows: <ApartmentOutlined />,
  Index: <BookOutlined />,
  Rules: <CheckCircleOutlined />,
  Skills: <ToolOutlined />
};
const KB_BLURB: Record<string, string> = {
  Rules: '规划时始终遵循的规则',
  Skills: '可复用的技能与做法',
  Workflows: '多步骤流程编排',
  Templates: '计划文档模板',
  Index: '关键词索引与检索种子',
  Dev: 'UI / 开发相关'
};

// First meaningful line, flattened to plain text — a one-glance preview of the doc.
function preview(content: string): string {
  for (const raw of content.split('\n')) {
    const line = toPlainText(raw);
    if (line) return line.length > 140 ? `${line.slice(0, 140)}…` : line;
  }
  return '';
}

interface Props {
  files: PlanFile[];
  onSelect: (path: string) => void;
}

export function KnowledgeBase({ files, onSelect }: Props) {
  const [q, setQ] = useState('');

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const byCat = new Map<string, PlanFile[]>();
    for (const f of files) {
      if (!KB_CATEGORIES.includes(f.category)) continue;
      if (needle && !`${f.name} ${f.title} ${f.content}`.toLowerCase().includes(needle)) continue;
      const list = byCat.get(f.category) ?? [];
      list.push(f);
      byCat.set(f.category, list);
    }
    return KB_CATEGORIES.filter((c) => byCat.has(c)).map((c) => ({
      category: c,
      files: byCat.get(c)!.sort((a, b) => a.title.localeCompare(b.title))
    }));
  }, [files, q]);

  const total = useMemo(() => files.filter((f) => KB_CATEGORIES.includes(f.category)).length, [files]);
  const shown = groups.reduce((n, g) => n + g.files.length, 0);

  return (
    <div className="kb">
      <div className="kb-hero">
        <div className="kb-eyebrow">智库 · Knowledge Base</div>
        <h1>
          AI 规划的<span className="accent">基础设施</span>
        </h1>
        <p className="kb-sub">
          规则、技能、流程与模板 —— 规划助手运行时所依赖的知识,与你的计划分开维护。
        </p>
      </div>

      <label className="kb-search">
        <SearchOutlined />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索规则 / 技能 / 模板…"
          aria-label="搜索智库"
        />
        <span className="kb-count">
          {shown}/{total}
        </span>
      </label>

      {groups.length === 0 ? (
        <div className="kb-empty">
          <div className="seal">智</div>
          <h3>{total === 0 ? '智库还是空的' : '没有匹配的条目'}</h3>
          <p>
            {total === 0
              ? '智库随应用一起播种 —— 规则、技能与模板会出现在这里。'
              : '换个搜索词试试。'}
          </p>
        </div>
      ) : (
        groups.map((g) => (
          <section className="kb-group" key={g.category}>
            <div className="kb-group-head">
              <span className="kb-group-icon">{KB_ICON[g.category]}</span>
              <h2>{CATEGORY_LABEL[g.category] ?? g.category}</h2>
              <span className="kb-group-n">{g.files.length}</span>
              {KB_BLURB[g.category] && <span className="kb-group-blurb">{KB_BLURB[g.category]}</span>}
            </div>
            <div className="kb-grid">
              {g.files.map((f) => (
                <button className="kb-card" key={f.path} onClick={() => onSelect(f.path)} title={f.path}>
                  <div className="kb-card-title">{f.title}</div>
                  <div className="kb-card-preview">{preview(f.content)}</div>
                  <div className="kb-card-path">{f.path}</div>
                </button>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
