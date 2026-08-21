import type { ReactNode } from 'react';

/**
 * One row in 资源 · Resources: a provisioned thing with a name, some badges, an explanation, maybe a
 * progress bar, and one action on the right.
 *
 * EXTRACTED because the same markup had reached three copies — the resource list, the built-in model, and
 * the Ollama runtime — and they had already started to drift: two of them rendered the size, one did not;
 * two composed the failure line differently. A row shape copied three times is a row shape that will look
 * like three different rows within a release or two.
 *
 * The SHELL is fixed (state classes · main/side split · where the bar goes); everything that varies is a
 * slot. Callers compose their own badges and lines, because what a row has to SAY differs completely — a
 * runtime reports whether it is serving, a model reports what it can do — while where those words sit
 * should not differ at all.
 */
export interface ResourceRowProps {
  /** The row's title. A node rather than a string so a caller can mix in mono for a version. */
  name: ReactNode;
  /** Badge spans, composed by the caller: 已安装 · 运行中 · 嵌入 · GPU 可用 are not one vocabulary. */
  badges?: ReactNode;
  /** One or more `.res-need` explanation lines. */
  lines?: ReactNode;
  /** Amber left edge — the console's "this is present and working" mark. */
  installed?: boolean;
  /** Red left edge. Distinct from `problem`: a row can carry a warning without being in a failed state. */
  failed?: boolean;
  /** A bar plus its own status line, while something is downloading. */
  progress?: { percent: number; message?: string | null } | null;
  /** The one sentence a household reads when this row is not usable. Composed by the caller — a runtime's
   *  "not running" and a download's "failed: …" are different sentences, not one with a prefix. */
  problem?: ReactNode;
  /** Approximate size in BYTES; rendered as `≈ N MB`. Omit for a row with nothing to download. */
  approxBytes?: number | null;
  /** The right-hand control — 下载 · 重新下载 · 启动 · or a 下载中… status. */
  action?: ReactNode;
}

const mb = (n: number) =>
  n >= 1_000_000_000 ? `${(n / 1_000_000_000).toFixed(1)} GB` : `${Math.round(n / 1_000_000)} MB`;

export function ResourceRow({
  name, badges, lines, installed, failed, progress, problem, approxBytes, action,
}: ResourceRowProps) {
  return (
    <div className={`res-item${installed ? ' ok' : ''}${failed ? ' err' : ''}`}>
      <div className="res-main">
        {/* Name and badges share ONE line: the badges are conditional, and giving them their own column
            would reflow the list depending on which rows happen to have them. */}
        <div className="res-name">{name}{badges}</div>
        {lines}
        {progress && (
          <>
            <div className="res-prog"><span className="res-bar" style={{ width: `${progress.percent}%` }} /></div>
            <div className="res-msg">{progress.message} · {progress.percent}%</div>
          </>
        )}
        {problem && <div className="res-msg danger">{problem}</div>}
      </div>
      <div className="res-side">
        {approxBytes != null && <div className="res-size">≈ {mb(approxBytes)}</div>}
        {action}
      </div>
    </div>
  );
}
