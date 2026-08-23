// 自动化 · Jobs — scheduled agent/tool/notify/report tasks and their run history.
//
// A section of the management console, lifted out of screens/Manage.tsx once that screen had reached
// 1957 lines holding eight of these. A screen is a surface you navigate TO; this renders inside one.
// See ./index.ts for why they share a folder.

import { useEffect, useState } from 'react';
import { PanelButton } from '@/ui/atoms';
import { Segmented, Field, CheckField } from '@/ui/molecules';

// ---- Automation view (background jobs: schedule / manage / run history) ----
interface Job {
  id: string; name: string; kind: string; configJson: string;
  scheduleKind: string; cron?: string | null; runAt?: string | null; timezone?: string | null;
  enabled: boolean; autoCommit: boolean; timeoutSeconds?: number | null; maxRuns?: number | null;
  runCount: number; consecutiveFailures: number;
  nextRunAt?: string | null; lastRunAt?: string | null; lastStatus?: string | null;
}
interface JobRun {
  id: string; jobId: string; startedAt: string; finishedAt?: string | null;
  status: string; outcome?: string | null; detail?: string | null; durationMs?: number | null;
}
interface JobsSettings { enabled: boolean; pollSeconds: number; catchUpGraceHours: number; defaultTimeoutSeconds: number; maxConsecutiveFailures: number; maxRetries: number; retryBackoffSeconds: number; }
interface JobMeta { kinds: string[]; tools: { name: string; description: string }[]; settings: JobsSettings; }

const KIND_LABEL: Record<string, string> = { agent: '智能体任务', tool: '工具调用', notify: '定时提醒', report: '生成报告' };
const KIND_HINT: Record<string, string> = {
  agent: '交给 AI 执行、会改文件的任务(默认暂存待审阅)',
  report: 'AI 只读分析,产出一份报告',
  tool: '调用一个确定性工具(不耗 token)',
  notify: '到点发送一条提醒通知',
};
const CRON_PRESETS = [
  { label: '每天9点', cron: '0 9 * * *' },
  { label: '每周一9点', cron: '0 9 * * 1' },
  { label: '每月1号9点', cron: '0 9 1 * *' },
  { label: '每周日20点', cron: '0 20 * * 0' },
  { label: '每小时', cron: '0 * * * *' },
];
const STATUS_LABEL: Record<string, string> = {
  success: '成功', failed: '失败', timeout: '超时', staged: '待审阅', rejected: '已拒绝', skipped: '已跳过', running: '运行中',
};
const fmtWhen = (iso?: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') : '—');
// Scheduled instants are stored UTC; show them in the job's own timezone so "每天9点" reads as 09:00,
// not the UTC 01:00. Falls back to the raw slice if the tz/date is unusable.
const fmtWhenTz = (iso?: string | null, tz?: string | null) => {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      hour12: false, timeZone: tz || undefined,
    }).format(new Date(iso)).replace(/\//g, '-');
  } catch { return fmtWhen(iso); }
};

export function JobsPanel({ toast, confirm }: {
  toast: (t: string, k?: 'ok' | 'err') => void;
  confirm: (t: string, o?: { danger?: boolean; okText?: string }) => Promise<boolean>;
}) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [settings, setSettings] = useState<JobsSettings | null>(null);
  const [meta, setMeta] = useState<JobMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [runs, setRuns] = useState<JobRun[]>([]);
  const [showForm, setShowForm] = useState(false);

  const [fName, setFName] = useState('');
  const [fKind, setFKind] = useState('report');
  const [fSchedule, setFSchedule] = useState<'once' | 'cron'>('cron');
  const [fCron, setFCron] = useState('0 9 * * *');
  const [fRunAt, setFRunAt] = useState('');
  const [fTimezone, setFTimezone] = useState('Asia/Shanghai');
  const [fInstructions, setFInstructions] = useState('');
  const [fTool, setFTool] = useState('');
  const [fNotifyTitle, setFNotifyTitle] = useState('');
  const [fNotifyBody, setFNotifyBody] = useState('');
  const [fAutoCommit, setFAutoCommit] = useState(false);
  const [fBusy, setFBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [j, m] = await Promise.all([
        fetch('/api/jobs').then((r) => r.json()),
        fetch('/api/jobs/meta').then((r) => r.json()),
      ]);
      setJobs(j.jobs ?? []);
      setSettings(j.settings ?? null);
      setMeta(m);
      if (m?.tools?.length) setFTool((prev) => prev || m.tools[0].name);
    } catch { /* leave */ } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const openRuns = async (id: string) => {
    const d = await fetch(`/api/jobs/${id}/runs?limit=20`).then((r) => r.json()).catch(() => ({ runs: [] }));
    setRuns(d.runs ?? []);
  };
  const toggleOpen = (id: string) => {
    if (openId === id) { setOpenId(null); return; }
    setOpenId(id); setRuns([]); openRuns(id);
  };

  const toggleKill = async () => {
    if (!settings) return;
    const next = !settings.enabled;
    setSettings({ ...settings, enabled: next });
    await fetch('/api/jobs/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: next }) }).catch(() => {});
    toast(next ? '已启用后台任务调度' : '已暂停全部后台任务');
  };

  const submit = async () => {
    const config: Record<string, unknown> =
      fKind === 'agent' || fKind === 'report' ? { instructions: fInstructions }
      : fKind === 'tool' ? { tool: fTool, args: {} }
      : { title: fNotifyTitle || fName, body: fNotifyBody };
    setFBusy(true);
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: fName, kind: fKind, config, schedule: fSchedule,
          cron: fSchedule === 'cron' ? fCron : undefined,
          runAt: fSchedule === 'once' ? fRunAt : undefined,
          timezone: fTimezone || undefined, autoCommit: fAutoCommit,
        }),
      });
      const jj = await res.json();
      if (res.ok) { toast('已创建任务'); setShowForm(false); setFName(''); setFInstructions(''); setFNotifyTitle(''); setFNotifyBody(''); load(); }
      else toast(`创建失败:${jj.error ?? res.status}`, 'err');
    } catch (e) { toast('创建失败:' + (e instanceof Error ? e.message : String(e)), 'err'); }
    finally { setFBusy(false); }
  };

  const setEnabled = async (job: Job, enabled: boolean) => {
    setJobs((prev) => prev.map((x) => (x.id === job.id ? { ...x, enabled } : x)));
    await fetch(`/api/jobs/${job.id}/enabled`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) }).catch(() => {});
  };
  const runNow = async (job: Job) => {
    toast(`正在运行「${job.name}」…`);
    try {
      const res = await fetch(`/api/jobs/${job.id}/run`, { method: 'POST' });
      const jj = await res.json();
      if (res.ok) { toast(`运行完成:${jj.run?.outcome ?? jj.run?.status ?? ''}`); if (openId === job.id) openRuns(job.id); load(); }
      else toast(`运行失败:${jj.error ?? res.status}`, 'err');
    } catch (e) { toast('运行失败:' + (e instanceof Error ? e.message : String(e)), 'err'); }
  };
  const del = async (job: Job) => {
    if (!(await confirm(`删除任务「${job.name}」?`, { danger: true, okText: '删除' }))) return;
    await fetch(`/api/jobs/${job.id}`, { method: 'DELETE' }).catch(() => {});
    if (openId === job.id) setOpenId(null);
    load();
  };
  const approve = async (run: JobRun) => {
    const res = await fetch(`/api/jobs/runs/${run.id}/approve`, { method: 'POST' });
    const jj = await res.json();
    if (res.ok) { toast(`已提交 ${jj.sha ?? ''}`); openRuns(run.jobId); }
    else toast(`提交失败:${jj.error ?? res.status}`, 'err');
  };
  const reject = async (run: JobRun) => {
    await fetch(`/api/jobs/runs/${run.id}/reject`, { method: 'POST' }).catch(() => {});
    openRuns(run.jobId); toast('已拒绝暂存的改动');
  };

  if (loading) return <div className="eval-empty">加载中…</div>;

  return (
    <div className="mng-view jobs">
      <div className="set-lead">
        后台任务:定时或一次性地跑分析报告、发提醒、执行工具或智能体任务。智能体改动默认<b>暂存待你审阅</b>。也可以直接在规划界面对 AI 说「每月…提醒我…」。
      </div>

      <div className="jobs-toolbar">
        <CheckField className="jobs-kill" checked={!!settings?.enabled} onChange={toggleKill}>
          {settings?.enabled ? '调度已启用' : '调度已暂停(全局开关)'}
        </CheckField>
        <PanelButton variant="primary" onClick={() => setShowForm((s) => !s)}>{showForm ? '取消' : '＋ 新建任务'}</PanelButton>
      </div>

      {showForm && (
        <div className="jobs-form">
          <div className="set-grid">
            <Field label="名称"><input value={fName} onChange={(e) => setFName(e.target.value)} placeholder="如:月度预算复盘" /></Field>
            <Field label="类型">
              <select value={fKind} onChange={(e) => setFKind(e.target.value)}>
                {(meta?.kinds ?? ['report', 'agent', 'tool', 'notify']).map((k) => <option key={k} value={k}>{KIND_LABEL[k] ?? k}</option>)}
              </select>
            </Field>
          </div>
          <div className="jobs-kindhint">{KIND_HINT[fKind]}</div>

          {(fKind === 'agent' || fKind === 'report') && (
            <Field label="指令 · Instructions">
              <textarea value={fInstructions} rows={3} onChange={(e) => setFInstructions(e.target.value)} placeholder="交给 AI 的任务描述(遵循知识库规则)" />
            </Field>
          )}
          {fKind === 'tool' && (
            <Field label="工具">
              <select value={fTool} onChange={(e) => setFTool(e.target.value)}>
                {(meta?.tools ?? []).map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
              </select>
            </Field>
          )}
          {fKind === 'notify' && (
            <div className="set-grid">
              <Field label="通知标题"><input value={fNotifyTitle} onChange={(e) => setFNotifyTitle(e.target.value)} /></Field>
              <Field label="通知内容"><input value={fNotifyBody} onChange={(e) => setFNotifyBody(e.target.value)} /></Field>
            </div>
          )}
          {fKind === 'agent' && (
            <CheckField checked={fAutoCommit} onChange={(v) => setFAutoCommit(v)}>自动提交改动(不勾选 = 暂存待你审阅,更安全)</CheckField>
          )}

          <Segmented
            className="jobs-seg"
            value={fSchedule}
            onSelect={setFSchedule}
            options={[
              { value: 'cron', label: '周期 · Cron' },
              { value: 'once', label: '一次 · Once' },
            ]}
          />
          {fSchedule === 'cron' ? (
            <div className="set-grid">
              <Field label="cron 表达式">
                <input value={fCron} onChange={(e) => setFCron(e.target.value)} placeholder="0 9 * * 1" />
                <span className="jobs-presets">{CRON_PRESETS.map((p) => <button type="button" key={p.cron} onClick={() => setFCron(p.cron)}>{p.label}</button>)}</span>
              </Field>
              <Field label="时区"><input value={fTimezone} onChange={(e) => setFTimezone(e.target.value)} placeholder="Asia/Shanghai" /></Field>
            </div>
          ) : (
            <Field label="执行时间 (ISO)"><input value={fRunAt} onChange={(e) => setFRunAt(e.target.value)} placeholder="2026-09-01T09:00:00Z" /></Field>
          )}

          <div className="set-actions">
            <PanelButton variant="primary" onClick={submit} disabled={fBusy || !fName}>{fBusy ? '创建中…' : '创建任务'}</PanelButton>
          </div>
        </div>
      )}

      {jobs.length === 0 ? (
        <div className="eval-empty">还没有后台任务。点「新建任务」,或在规划界面让 AI 帮你安排。</div>
      ) : (
        <div className="jobs-list">
          {jobs.map((job) => (
            <div className="jobs-item" key={job.id}>
              <div className="jobs-row">
                <button className="jobs-caret" onClick={() => toggleOpen(job.id)}>{openId === job.id ? '▾' : '▸'}</button>
                <div className="jobs-row-main" onClick={() => toggleOpen(job.id)}>
                  <div className="jobs-row-name">{job.name} <span className={`jobs-kind k-${job.kind}`}>{KIND_LABEL[job.kind] ?? job.kind}</span>{!job.enabled && <span className="jobs-off">已停用</span>}</div>
                  <div className="jobs-row-meta">
                    <span>{job.scheduleKind === 'cron' ? `cron ${job.cron}` : `一次 ${fmtWhenTz(job.runAt, job.timezone)}`}</span>
                    <span>下次 {fmtWhenTz(job.nextRunAt, job.timezone)}{job.timezone ? ` (${job.timezone})` : ''}</span>
                    {job.lastStatus && <span className={`jobs-st s-${job.lastStatus}`}>{STATUS_LABEL[job.lastStatus] ?? job.lastStatus}</span>}
                    <span>运行 {job.runCount} 次</span>
                  </div>
                </div>
                <div className="jobs-row-actions">
                  <CheckField
                    checked={job.enabled}
                    title={job.enabled ? '已启用' : '已停用'}
                    onChange={(v) => setEnabled(job, v)}
                  />
                  <PanelButton compact onClick={() => runNow(job)}>运行</PanelButton>
                  <PanelButton variant="ghost" compact onClick={() => del(job)}>删除</PanelButton>
                </div>
              </div>
              {openId === job.id && (
                <div className="jobs-runs">
                  {runs.length === 0 ? <div className="jobs-runs-empty">暂无运行记录</div> : runs.map((r) => (
                    <div className={`jobs-run s-${r.status}`} key={r.id}>
                      <span className={`jobs-st s-${r.status}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
                      <span className="jobs-run-out">{r.outcome ?? ''}</span>
                      <span className="jobs-run-when">{fmtWhen(r.startedAt)}</span>
                      {r.status === 'staged' && (
                        <span className="jobs-run-btns">
                          <PanelButton variant="primary" compact onClick={() => approve(r)}>批准提交</PanelButton>
                          <PanelButton variant="ghost" compact onClick={() => reject(r)}>拒绝</PanelButton>
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
