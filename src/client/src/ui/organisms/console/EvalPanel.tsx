// 对话评估 · Eval — rated conversations, scorer aggregates and a run trace per turn.
//
// A section of the management console, lifted out of screens/Manage.tsx once that screen had reached
// 1957 lines holding eight of these. A screen is a surface you navigate TO; this renders inside one.
// See ./index.ts for why they share a folder.

import { useEffect, useState } from 'react';
import { formatCount } from '@/lib/format';

interface Conversation {
  id: string;
  phase: string;
  mode: string;
  userMessage?: string | null;
  commitSha?: string | null;
  error?: string | null;
  createdAt: string;
  rating?: number | null;
  note?: string | null;
  avgScore?: number | null;
  scoreCount?: number;
}
interface Stats {
  total: number;
  rated: number;
  avgRating: number;
  distribution: { rating: number; count: number }[];
}
interface ScorerMeta {
  id: string;
  name: string;
  description: string;
  group: string;
  isLlm: boolean;
}
interface ScoreAgg {
  scorerId: string;
  avgScore: number;
  count: number;
}
interface StoredScore {
  scorerId: string;
  score: number;
  reason?: string | null;
  isLlm: boolean;
}
interface TraceStep {
  seq: number;
  kind: string;
  label: string;
  detail?: string | null;
  durationMs: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
}
interface RunTrace {
  totalDurationMs: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  steps: TraceStep[];
}

const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

export function EvalPanel() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [rows, setRows] = useState<Conversation[]>([]);
  const [scorers, setScorers] = useState<ScorerMeta[]>([]);
  const [agg, setAgg] = useState<ScoreAgg[]>([]);
  const [scoring, setScoring] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const [s, c, sc, a] = await Promise.all([
        fetch('/api/manage/stats').then((r) => r.json()),
        fetch('/api/manage/conversations?limit=100').then((r) => r.json()),
        fetch('/api/manage/scores/scorers').then((r) => r.json()),
        fetch('/api/manage/scores/aggregate').then((r) => r.json()),
      ]);
      setStats(s);
      setRows(c.conversations ?? []);
      setScorers(sc.scorers ?? []);
      setAgg(a.scorers ?? []);
    } catch {
      /* leave empty */
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
  }, []);

  const runScorers = async () => {
    setScoring(true);
    try {
      await fetch('/api/manage/scores/run-all', { method: 'POST' });
      // batch scoring runs in the background — give the judges a moment, then refresh.
      await new Promise((r) => setTimeout(r, 2500));
      await load();
    } finally {
      setScoring(false);
    }
  };

  // Expand a conversation → load its run trace + per-dimension scores.
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ trace: RunTrace; scores: StoredScore[] } | null>(null);
  const toggle = async (id: string) => {
    if (openId === id) { setOpenId(null); return; }
    setOpenId(id);
    setDetail(null);
    try {
      const [t, s] = await Promise.all([
        fetch(`/api/manage/trace/${id}`).then((r) => r.json()),
        fetch(`/api/manage/scores/${id}`).then((r) => r.json()),
      ]);
      setDetail({ trace: t, scores: s.scores ?? [] });
    } catch {
      /* leave detail null */
    }
  };

  const maxDist = Math.max(1, ...(stats?.distribution ?? []).map((d) => d.count));
  const distByStar = (n: number) => stats?.distribution.find((d) => d.rating === n)?.count ?? 0;

  return (
    <div className="mng-view">
      <div className="eval-stats">
        <div className="eval-stat"><div className="n">{stats?.total ?? '—'}</div><div className="l">对话总数 Conversations</div></div>
        <div className="eval-stat"><div className="n">{stats?.rated ?? '—'}</div><div className="l">已评分 Rated</div></div>
        <div className="eval-stat"><div className="n">{stats?.avgRating ? stats.avgRating.toFixed(2) : '—'}<small> / 5</small></div><div className="l">平均分 Avg rating</div></div>
        <div className="eval-stat">
          <div className="eval-bar">
            {[5, 4, 3, 2, 1].map((n) => (
              <span className="b" key={n} title={`${n}★ · ${distByStar(n)}`}>
                <span style={{ ['--h' as any]: `${(distByStar(n) / maxDist) * 100}%` }} />
              </span>
            ))}
          </div>
          <div className="l">评分分布 5★→1★</div>
        </div>
      </div>

      {scorers.length > 0 && (
        <div className="eval-scorers">
          <div className="eval-toolbar">
            <h2>自动评分 · Scorers</h2>
            <button className="eval-export" onClick={runScorers} disabled={scoring}>{scoring ? '评分中…' : '运行评分(未评分对话)'}</button>
          </div>
          <div className="eval-scorer-grid">
            {scorers.map((s) => {
              const a = agg.find((x) => x.scorerId === s.id);
              const pct = a ? Math.round(a.avgScore * 100) : 0;
              return (
                <div className={`eval-scorer${s.group === 'guardrails' ? ' guard' : ''}`} key={s.id} title={s.description}>
                  <div className="eval-scorer-top">
                    <span className="nm">{s.name}{s.isLlm && <span className="llm">LLM</span>}</span>
                    <span className="v">{a ? a.avgScore.toFixed(2) : '—'}</span>
                  </div>
                  <div className="eval-scorer-bar"><span style={{ width: `${pct}%` }} /></div>
                  <div className="eval-scorer-sub">{a ? `${a.count} 次评分` : '未评分'}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="eval-toolbar">
        <h2>对话记录</h2>
        <button className="eval-export" onClick={() => window.open('/api/manage/eval/export', '_blank')}>导出评估数据集 (JSONL)</button>
      </div>

      {loading ? (
        <div className="eval-empty">加载中…</div>
      ) : rows.length === 0 ? (
        <div className="eval-empty">还没有对话。用规划界面的 AI 助手对话,结束后为它打分,数据会出现在这里。</div>
      ) : (
        <div className="eval-list">
          {rows.map((c) => (
            <div className="eval-item" key={c.id}>
              <div className={`eval-row clickable${openId === c.id ? ' open' : ''}`} onClick={() => toggle(c.id)}>
                <span className="eval-caret">{openId === c.id ? '▾' : '▸'}</span>
                <div className="eval-row-main">
                  <div className="eval-row-msg">{c.userMessage || '(空)'}</div>
                  <div className="eval-row-meta">
                    <span className="phase">{c.phase}</span>
                    {c.mode === 'system' && <span>系统模式</span>}
                    {c.commitSha && <span className="k">{c.commitSha.slice(0, 7)}</span>}
                    {!!c.scoreCount && c.avgScore != null && (
                      <span className="score" title={`${c.scoreCount} 个维度自动评分`}>评分 {c.avgScore.toFixed(2)}</span>
                    )}
                    <span>{c.createdAt.slice(0, 16).replace('T', ' ')}</span>
                  </div>
                  {c.note && <div className="eval-row-note">“{c.note}”</div>}
                </div>
                {c.rating ? (
                  <div className="eval-row-rating">
                    <span className="on">{'★'.repeat(c.rating)}</span>
                    <span className="off">{'★'.repeat(5 - c.rating)}</span>
                  </div>
                ) : (
                  <div className="eval-row-rating unrated">未评分</div>
                )}
              </div>
              {openId === c.id && <ConversationDetail detail={detail} scorers={scorers} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Conversation detail: run trace (phase timeline + tools + LLM runs) + per-dimension scores ----
function ConversationDetail({ detail, scorers }: { detail: { trace: RunTrace; scores: StoredScore[] } | null; scorers: ScorerMeta[] }) {
  if (!detail) return <div className="eval-detail loading">加载运行轨迹…</div>;
  const { trace, scores } = detail;
  const nameOf = (id: string) => scorers.find((s) => s.id === id)?.name ?? id;
  return (
    <div className="eval-detail">
      <div className="eval-trace-totals">
        <span>耗时 <b>{fmtMs(trace.totalDurationMs)}</b></span>
        <span>工具 <b>{trace.toolCalls}</b></span>
        <span>输入 <b>{formatCount(trace.inputTokens)}</b> tok</span>
        <span>输出 <b>{formatCount(trace.outputTokens)}</b> tok</span>
        {trace.costUsd > 0 && <span>成本 <b>${trace.costUsd.toFixed(4)}</b></span>}
      </div>
      <div className="eval-trace">
        {trace.steps.map((s, i) => (
          <div className={`eval-tstep ${s.kind}`} key={i}>
            <span className="k">{s.kind}</span>
            <span className="lb">{s.label}{s.detail ? <em> · {s.detail}</em> : null}</span>
            {s.kind === 'usage' ? (
              <span className="d">{formatCount(s.inputTokens ?? 0)}/{formatCount(s.outputTokens ?? 0)} tok</span>
            ) : s.durationMs > 0 ? (
              <span className="d">{fmtMs(s.durationMs)}</span>
            ) : null}
          </div>
        ))}
      </div>
      {scores.length > 0 && (
        <div className="eval-detail-scores">
          {scores.map((sc) => (
            <div className="eval-dscore" key={sc.scorerId} title={sc.reason ?? ''}>
              <span className="nm">{nameOf(sc.scorerId)}{sc.isLlm && <span className="llm">LLM</span>}</span>
              <span className="bar"><span className={sc.score >= 0.75 ? 'ok' : sc.score >= 0.4 ? 'mid' : 'low'} style={{ width: `${Math.round(sc.score * 100)}%` }} /></span>
              <span className="v">{sc.score.toFixed(2)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
