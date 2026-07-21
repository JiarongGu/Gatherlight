import { useEffect, useRef, useState } from 'react';
import { Button, Spin, Alert } from '@/ui/atoms';
import { getMigrationStatus, retryMigration, type MigrationSnapshot } from '@/lib/migrationApi';

const STEP_ICON: Record<string, string> = { pending: '○', running: '…', ok: '✓', failed: '✗', skipped: '–' };

/** Full-screen progress layer shown while the server's startup migration runs. Polls the status feed;
 *  on completion (after having been migrating) it reloads so the console loads fresh. Renders nothing
 *  when the server is already serving. */
export function MigrationOverlay() {
  const [snap, setSnap] = useState<MigrationSnapshot | null>(null);
  const [retrying, setRetrying] = useState(false);
  const wasMigrating = useRef(false);

  useEffect(() => {
    let alive = true;
    let timer: number;
    const poll = async () => {
      try {
        const s = await getMigrationStatus();
        if (!alive) return;
        setSnap(s);
        if (s.phase === 'completed') {
          if (wasMigrating.current) window.location.reload();
          return; // stop polling — serving normally
        }
        wasMigrating.current = true;
        timer = window.setTimeout(poll, 500);
      } catch {
        if (alive) timer = window.setTimeout(poll, 800);
      }
    };
    void poll();
    return () => { alive = false; window.clearTimeout(timer); };
  }, []);

  if (!snap || snap.phase === 'completed') return null;

  const failed = snap.phase === 'failed';
  const title = snap.isUpgrade ? `正在升级到 v${snap.toVersion}…` : '正在启动…';

  const onRetry = async () => {
    setRetrying(true);
    try { await retryMigration(); } catch { /* poll will reflect state */ }
    finally { setRetrying(false); wasMigrating.current = true; }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999, background: 'var(--bg)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 18, fontWeight: 600, color: 'var(--text)' }}>
        {!failed && <Spin size="small" />}{title}
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, minWidth: 280, maxWidth: 480 }}>
        {snap.steps.map((s) => (
          <li key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', opacity: s.status === 'pending' ? 0.5 : 1 }}>
            <span style={{ width: 16, textAlign: 'center', color: s.status === 'failed' ? 'var(--danger, #d33)' : 'var(--accent)' }}>
              {s.status === 'running' ? <Spin size="small" /> : STEP_ICON[s.status]}
            </span>
            <span style={{ color: 'var(--text)' }}>{s.title}</span>
            {s.status === 'failed' && s.error && <span style={{ color: 'var(--danger, #d33)', fontSize: 12 }}>— {s.error}</span>}
          </li>
        ))}
      </ul>
      {snap.warnings.map((w, i) => (
        <Alert key={i} type="warning" showIcon message={w} style={{ maxWidth: 480 }} />
      ))}
      {failed && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          <Alert type="error" showIcon message={snap.error ?? '升级失败'} style={{ maxWidth: 480 }} />
          <div style={{ display: 'flex', gap: 8 }}>
            <Button type="primary" loading={retrying} onClick={() => void onRetry()}>重试</Button>
            <Button onClick={() => { try { (window as any).chrome?.webview?.postMessage('openLogs'); } catch { /* browser */ } }}>打开日志</Button>
          </div>
        </div>
      )}
    </div>
  );
}
