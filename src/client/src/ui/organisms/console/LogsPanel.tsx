// 日志 · Logs — the day file tail, and the host action that opens the folder.
//
// A section of the management console, lifted out of screens/Manage.tsx once that screen had reached
// 1957 lines holding eight of these. A screen is a surface you navigate TO; this renders inside one.
// See ./index.ts for why they share a folder.

import { useEffect, useRef, useState } from 'react';
import { CheckField } from '@/ui/molecules';
import { PanelButton } from '@/ui/atoms';
import { hostPost, inHost } from '@/lib/host';

// ---- Logs view (tail the app's daily file logs under {data}/state/logs) ----
interface LogsData {
  dir: string;
  files: string[];
  file: string | null;
  lines: string[];
}
export function LogsPanel() {
  const [data, setData] = useState<LogsData | null>(null);
  const [file, setFile] = useState('');
  const [auto, setAuto] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  const load = async (f?: string) => {
    try {
      const q = (f ?? file) ? `?file=${encodeURIComponent(f ?? file)}` : '';
      const d: LogsData = await (await fetch(`/api/manage/logs${q}`)).json();
      setData(d);
      if (!file && d.file) setFile(d.file);
    } catch {
      /* keep last */
    }
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => load(), 3000);
    return () => clearInterval(t);
  }, [auto, file]);
  // Stick to the bottom after each refresh (newest lines).
  useEffect(() => { if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight; }, [data]);

  const cls = (l: string) =>
    /\[(ERROR|CRIT)/.test(l) ? ' err' : /\[WARN/.test(l) ? ' warn' : /^\s*(→|at )/.test(l) ? ' dim' : '';

  if (!data) return <div className="eval-empty">加载中…</div>;

  return (
    <div className="mng-view logs">
      <div className="logs-bar">
        <select className="logs-file" value={file} onChange={(e) => { setFile(e.target.value); load(e.target.value); }}>
          {data.files.length === 0 && <option value="">(暂无日志)</option>}
          {data.files.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <PanelButton onClick={() => load()}>刷新</PanelButton>
        <CheckField checked={auto} onChange={(v) => setAuto(v)}>自动刷新(3s)</CheckField>
        {inHost && <PanelButton onClick={() => hostPost('openLogs')}>打开日志文件夹</PanelButton>}
        <span className="logs-path" title={data.dir}>{data.dir}</span>
      </div>
      {data.files.length === 0 ? (
        <div className="eval-empty">暂无日志 —— 应用运行后会写入 state/logs/。</div>
      ) : (
        <pre className="logs-view" ref={preRef}>
          {data.lines.map((l, i) => <div className={`logs-line${cls(l)}`} key={i}>{l || ' '}</div>)}
        </pre>
      )}
    </div>
  );
}
