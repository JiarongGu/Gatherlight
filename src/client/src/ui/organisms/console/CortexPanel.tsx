// 校准 · Cortex — prompts, per-consumer model routing, knowledge-base upgrades, memory recall.
//
// A section of the management console, lifted out of screens/Manage.tsx once that screen had reached
// 1957 lines holding eight of these. A screen is a surface you navigate TO; this renders inside one.
// See ./index.ts for why they share a folder.

import { useEffect, useState } from 'react';
import { MemoryRecallPanel } from './MemoryRecallPanel';

// ---- Cortex tuning view (prompt-template + model-routing overrides) ----
interface PromptItem {
  name: string;
  label: string;
  description: string;
  group: string;
  placeholders: string[];
  default: string;
  override: string | null;
  effective: string;
  overridden: boolean;
}
interface ModelItem {
  consumer: string;
  label: string;
  description: string;
  default: string | null;
  override: string | null;
  effective: string | null;
  overridden: boolean;
  suggestions: string[];
}

const GROUP_LABELS: Record<string, string> = {
  planner: '规划闸门 · Planner gates',
  validation: '智库校验 · Validation',
  utility: '工具 · Utility',
  system: '系统模式 · System mode',
};
const GROUP_ORDER = ['planner', 'validation', 'utility', 'system'];
const modelLabel = (v: string | null) => (v && v.length ? v : 'CLI 默认');

// ---- Knowledge-base upgrade migration (customized .claude/ files vs. shipped template improvements) ----
interface KbStatus {
  available: { path: string }[];
  hasStaged: boolean;
  staged?: { path: string; status: string; diff: string }[] | null;
  stagedAt?: string | null;
  progress?: {
    current: number; total: number; file?: string | null; running: boolean;
    outChars?: number; tokens?: number; costUsd?: number; elapsedMs?: number; model?: string | null;
  } | null;
}

const fmtElapsed = (ms?: number) => {
  const s = Math.max(0, Math.round((ms ?? 0) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
};
const fmtUsd = (n?: number) => {
  const v = n ?? 0;
  if (v <= 0) return null;
  return v < 0.001 ? '<$0.001' : `$${v.toFixed(v < 1 ? 3 : 2)}`;
};
function KbUpgradesCard({ toast }: { toast: (t: string, k?: 'ok' | 'err') => void }) {
  const [status, setStatus] = useState<KbStatus | null>(null);
  const [busy, setBusy] = useState(false); // local (approve/reject/starting) — not the merge itself
  const load = async () => { try { setStatus(await (await fetch('/api/manage/kb-upgrades')).json()); } catch { /* ignore */ } };
  useEffect(() => { load(); }, []);

  // The merge runs server-side; its progress is server truth. Poll while a run is in flight — `running`
  // (server truth) so the live status survives leaving this tab and coming back or a full reload, plus
  // `busy` so the initiating click polls during the blocking POST before `running` has flipped on. The
  // old bug: busy + the poll lived only in local state and died on unmount, leaving a blank card.
  const running = status?.progress?.running ?? false;
  const active = running || busy;
  useEffect(() => {
    if (!active) return;
    const id = setInterval(load, 1000);
    return () => clearInterval(id);
  }, [active]);

  if (!status) return null;
  const nAvail = status.available?.length ?? 0;
  if (!status.hasStaged && nAvail === 0 && !running) return null; // nothing to surface
  const prog = status.progress;

  const run = async () => {
    if (busy || running) return;
    setBusy(true);
    await load(); // flip `running` on quickly so the poll effect above takes over the live updates
    try {
      const res = await fetch('/api/manage/kb-upgrades/run', { method: 'POST' });
      const r = await res.json();
      if (res.ok && r.staged) toast(`已合并 ${r.merged} 个文件${r.failed ? `(${r.failed} 个失败)` : ''},请审阅`);
      else toast(r.error ?? '合并无改动', res.ok ? 'ok' : 'err');
    } catch { toast('合并失败', 'err'); }
    finally { setBusy(false); await load(); }
  };
  const approve = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/manage/kb-upgrades/approve', { method: 'POST' });
      const r = await res.json();
      toast(res.ok ? `已应用升级 ${r.sha ?? ''}` : (r.error ?? '应用失败'), res.ok ? 'ok' : 'err');
      await load();
    } finally { setBusy(false); }
  };
  const reject = async () => {
    setBusy(true);
    try { await fetch('/api/manage/kb-upgrades/reject', { method: 'POST' }); toast('已保留你的版本'); await load(); }
    finally { setBusy(false); }
  };

  return (
    <div className="kbup">
      <div className="kbup-title">🔄 知识库升级 · Knowledge-base upgrades</div>
      {status.hasStaged ? (
        <>
          <div className="kbup-desc">已把 {status.staged?.length ?? 0} 个文件与新模板合并(保留你的自定义 + 采纳改进),审阅后应用:</div>
          <div className="kbup-diffs">
            {status.staged?.map((f) => (
              <details className="kbup-file" key={f.path}>
                <summary>{f.path} <span className="jobs-kind">{f.status}</span></summary>
                <pre className="kbup-diff">
                  {(f.diff || '').split('\n').map((l, i) => (
                    <div key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : ''}>{l || ' '}</div>
                  ))}
                </pre>
              </details>
            ))}
          </div>
          <div className="kbup-btns">
            <button className="cx-btn primary" onClick={approve} disabled={busy}>应用升级</button>
            <button className="cx-btn ghost" onClick={reject} disabled={busy}>保留我的版本</button>
          </div>
        </>
      ) : (
        <>
          <div className="kbup-desc">{nAvail} 个你自定义过的知识库文件有新模板改进。AI 合并会保留你的改动并采纳改进,结果需你审阅后才生效。</div>
          <ul className="kbup-list">{status.available.map((u) => <li key={u.path}>{u.path}</li>)}</ul>
          {running && prog && (
            <div className="kbup-progress">
              <div className="kbup-progress-head">
                合并中 {prog.current}/{prog.total}
                {prog.file ? <> · <code>{prog.file}</code></> : null}
                {prog.model ? <> · {prog.model}</> : null}
              </div>
              <div className="kbup-progress-live">
                ⏱ {fmtElapsed(prog.elapsedMs)}
                {prog.outChars ? <> · 生成中 ~{prog.outChars.toLocaleString()} 字</> : null}
                {prog.tokens ? <> · {prog.tokens.toLocaleString()} tok</> : null}
                {fmtUsd(prog.costUsd) ? <> · ~{fmtUsd(prog.costUsd)}</> : null}
              </div>
            </div>
          )}
          <div className="kbup-btns">
            <button className="cx-btn primary" onClick={run} disabled={busy || running}>
              {running
                ? `合并中 ${prog?.current ?? 0}/${prog?.total ?? 0}…（AI）`
                : busy ? '启动中…' : '运行合并(AI)'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function CortexPanel({ toast, onRestart }: { toast: (t: string, k?: 'ok' | 'err') => void; onRestart: () => void }) {
  const [prompts, setPrompts] = useState<PromptItem[]>([]);
  const [models, setModels] = useState<ModelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const d = await (await fetch('/api/manage/cortex')).json();
      setPrompts(d.prompts ?? []);
      setModels(d.models ?? []);
    } catch {
      /* leave empty */
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
  }, []);

  const expand = (p: PromptItem) => {
    if (open === p.name) {
      setOpen(null);
      return;
    }
    setOpen(p.name);
    setDraft(p.effective);
    setErr(null);
  };

  const savePrompt = async (p: PromptItem) => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/manage/cortex/prompt/${p.name}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: draft }),
      });
      if (res.ok) {
        setOpen(null);
        await load();
      } else {
        const j = await res.json().catch(() => ({}));
        setErr(
          j.missing?.length
            ? `缺少占位符:${j.missing.map((m: string) => `{${m}}`).join(' ')} — 覆写必须保留全部占位符,否则动态内容会丢失。`
            : `保存失败:${j.error ?? res.status}`,
        );
      }
    } catch (e) {
      setErr('保存失败:' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  const resetPrompt = async (p: PromptItem) => {
    setBusy(true);
    setErr(null);
    try {
      await fetch(`/api/manage/cortex/prompt/${p.name}`, { method: 'DELETE' });
      setOpen(null);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const setModel = async (m: ModelItem, value: string) => {
    if ((m.override ?? '') === value) return;
    setModels((prev) => prev.map((x) => (x.consumer === m.consumer ? { ...x, override: value || null, overridden: !!value, effective: value || m.default } : x)));
    try {
      await fetch(`/api/manage/cortex/model/${m.consumer}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value }),
      });
    } finally {
      load();
    }
  };

  if (loading) return <div className="eval-empty">加载中…</div>;

  return (
    <div className="cx mng-view">
      <div className="cx-lead">
        校准“cortex”——每次 LLM 调用所用的提示词与模型都在这里调,存入 <code>app_config</code>,下次调用即时生效,无需重启。
        与「对话评估」形成闭环:先评分收集数据,再回到这里调提示词/模型。
      </div>

      <KbUpgradesCard toast={toast} />

      <MemoryRecallPanel toast={toast} onRestart={onRestart} />

      <div className="mng-title">模型路由 · Model routing</div>
      <div className="cx-models">
        {models.map((m) => (
          <div className={`cx-model${m.overridden ? ' on' : ''}`} key={m.consumer}>
            <div className="cx-model-head">
              <span className="cx-model-name">{m.label}</span>
              {m.overridden && <span className="cx-badge">已自定义</span>}
            </div>
            <div className="cx-model-desc">{m.description}</div>
            <div className="cx-seg">
              {m.suggestions.map((s) => {
                const active = (m.override ?? '') === s;
                return (
                  <button
                    key={s || 'default'}
                    className={`cx-seg-b${active ? ' on' : ''}`}
                    onClick={() => setModel(m, s)}
                    title={s ? s : `使用默认(${modelLabel(m.default)})`}
                  >
                    {s ? s : '默认'}
                  </button>
                );
              })}
            </div>
            <div className="cx-model-eff">
              生效:<b>{modelLabel(m.effective)}</b>
              {m.default !== null && <span className="cx-dim"> · 默认 {modelLabel(m.default)}</span>}
            </div>
          </div>
        ))}
      </div>

      <div className="mng-title">提示词模板 · Prompt templates</div>
      {GROUP_ORDER.filter((g) => prompts.some((p) => p.group === g)).map((g) => (
        <div className="cx-group" key={g}>
          <div className="cx-group-h">{GROUP_LABELS[g] ?? g}</div>
          {prompts
            .filter((p) => p.group === g)
            .map((p) => (
              <div className={`cx-prompt${open === p.name ? ' open' : ''}${p.overridden ? ' on' : ''}`} key={p.name}>
                <button className="cx-prompt-head" onClick={() => expand(p)}>
                  <span className="cx-caret">{open === p.name ? '▾' : '▸'}</span>
                  <span className="cx-prompt-main">
                    <span className="cx-prompt-label">
                      {p.label}
                      {p.overridden && <span className="cx-badge">已自定义</span>}
                    </span>
                    <span className="cx-prompt-desc">{p.description}</span>
                  </span>
                  <span className="cx-chips">
                    {p.placeholders.map((ph) => (
                      <code key={ph}>{`{${ph}}`}</code>
                    ))}
                  </span>
                </button>
                {open === p.name && (
                  <div className="cx-editor">
                    <textarea
                      value={draft}
                      spellCheck={false}
                      onChange={(e) => setDraft(e.target.value)}
                      rows={Math.min(26, Math.max(8, draft.split('\n').length + 1))}
                    />
                    {err && <div className="cx-err">{err}</div>}
                    <div className="cx-editor-bar">
                      <span className="cx-hint">
                        必须保留占位符:{p.placeholders.length ? p.placeholders.map((ph) => `{${ph}}`).join(' ') : '(无)'}
                      </span>
                      <div className="cx-editor-btns">
                        <button className="cx-btn ghost" onClick={() => setOpen(null)} disabled={busy}>
                          收起
                        </button>
                        {p.overridden && (
                          <button className="cx-btn ghost" onClick={() => resetPrompt(p)} disabled={busy}>
                            重置为默认
                          </button>
                        )}
                        <button className="cx-btn primary" onClick={() => savePrompt(p)} disabled={busy || draft === p.effective}>
                          保存
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}
