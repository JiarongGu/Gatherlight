import { useState } from 'react';

/** A model download the server has in flight, or one that finished in the last few minutes. */
export interface ModelPullState {
  model: string;
  running: boolean;
  /** Null while the daemon is resolving manifests and has no total to divide by — rendered as
   *  indeterminate, because a bar pinned at 0% reads as stuck. */
  percent: number | null;
  status: string | null;
  error: string | null;
}

/**
 * A download in flight, or the outcome of one that just finished.
 *
 * It exists because the pull used to be awaited INSIDE the POST: the button said 下载中… and nothing else
 * changed for however long a gigabyte takes on the household's line — indistinguishable from a hang.
 * Renders nothing when there is no download, so every caller can mount it unconditionally.
 */
export function PullProgress({ pull }: { pull: ModelPullState | null }) {
  if (!pull) return null;
  if (!pull.running) {
    return pull.error
      ? <div className="mem-fine danger">下载失败:{pull.error}</div>
      : <div className="mem-fine">下载完成。</div>;
  }
  return (
    <div className="mem-prog">
      {/* The 6% floor is for the indeterminate case only: a bar with no width at all reads as one that has
          not started, which is exactly wrong while manifests are being fetched. */}
      <div className="res-prog"><span className="res-bar" style={{ width: `${pull.percent ?? 6}%` }} /></div>
      <div className="mem-fine">
        {pull.percent === null ? '正在准备…' : `${pull.percent}%`}
        {pull.status ? ` · ${pull.status}` : ''}
      </div>
    </div>
  );
}

/**
 * Pull a model the shortlist has never heard of.
 *
 * THE LIST IS NOT THE LIMIT: a catalog baked into a release cannot contain a model published after it —
 * which is exactly how the panel once shipped without the two best models available at the time. Anything
 * the daemon can pull is usable the day it exists.
 */
export function ModelPullField(
  { busy, pullOf, onPull, label, placeholder, hint }:
  {
    busy: string | null;
    pullOf: (id: string) => ModelPullState | null;
    onPull: (id: string) => void;
    label: string;
    placeholder: string;
    hint: string;
  },
) {
  const [id, setId] = useState('');
  const pull = id ? pullOf(id) : null;
  return (
    <div className="mem-other">
      <label className="set-field">
        <span>{label}</span>
        <input value={id} onChange={(e) => setId(e.target.value.trim())} placeholder={placeholder} />
      </label>
      <div className="mem-other-act">
        {pull?.running
          ? <span className="res-running">下载中…</span>
          : (
            <button className="cx-btn" disabled={!id || busy === 'pull:other'} onClick={() => onPull(id)}>
              下载
            </button>
          )}
      </div>
      <PullProgress pull={pull} />
      <div className="mem-fine">{hint}</div>
    </div>
  );
}
