// The chat's phase indicator and its token line.
//
// `PhaseSteps` is a MOLECULE in the strict sense: the `Stepper` atom plus this feature's own
// vocabulary (which phases exist, what they are called, which counts as done). It used to be a local
// function called `Stepper`, which forced the atom to be imported as `StepperBar` to dodge the
// collision — the alias was the file telling us the name was wrong.
import { Stepper, Tooltip } from '@/ui/atoms';
import type { Phase } from '@/lib/chatTypes';
import type { ChatState } from './chatReducer';

const STEPS: { key: Phase; label: string }[] = [
  { key: 'planning', label: '计划' },
  { key: 'awaiting-plan-approval', label: '审计划' },
  { key: 'executing', label: '执行' },
  { key: 'awaiting-diff-approval', label: '审改动' },
  { key: 'committed', label: '提交' }
];
const STEP_ORDER: Record<string, number> = {
  planning: 0,
  'awaiting-plan-approval': 1,
  executing: 2,
  building: 2,
  validating: 2,
  'awaiting-diff-approval': 3,
  'awaiting-input': 2,
  'awaiting-mcp-approval': 2,
  'awaiting-login': 2,
  'awaiting-draft-approval': 2,
  'awaiting-capability-approval': 2,
  committing: 4,
  committed: 4
};

export function PhaseSteps({ phase }: { phase: Phase }) {
  if (phase === 'idle') return null;
  const current = STEP_ORDER[phase] ?? -1;
  return <Stepper steps={STEPS} current={current} allDone={phase === 'committed'} />;
}

const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Cumulative session token usage — one line under the stepper, updates live via SSE. */
export function UsageLine({ usage, live }: { usage: ChatState['usage']; live: ChatState['liveUsage'] }) {
  // Committed session totals + the in-flight run's live ticks, so tokens climb during a long
  // plan/research phase instead of only appearing at the end.
  const input = usage.inputTokens + live.inputTokens;
  const output = usage.outputTokens + live.outputTokens;
  const cacheRead = usage.cacheReadTokens + live.cacheReadTokens;
  if (input + output === 0) return null;
  const streaming = live.inputTokens + live.outputTokens > 0;
  return (
    <Tooltip title={`输入 ${input.toLocaleString()} · 输出 ${output.toLocaleString()} · 缓存读取 ${cacheRead.toLocaleString()}`}>
      <div className={`chat-usage${streaming ? ' live' : ''}`}>
        ⚡ {fmtTokens(input)} in · {fmtTokens(output)} out
        {usage.costUsd > 0 && <> · ~USD {usage.costUsd.toFixed(3)}</>}
        {streaming && <> · 计算中…</>}
      </div>
    </Tooltip>
  );
}

/** The awaiting-mcp-approval gate: show the CONCRETE launch spec (server-rendered, no secrets) +
 *  one masked field per needed credential, and confirm/decline. The command/url is display-only —
 *  approval sends only the credential values; the server uses its own stored draft for what runs. */
