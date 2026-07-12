import { spawn } from 'node:child_process';
import path from 'node:path';

const IS_WIN = process.platform === 'win32';

/**
 * Run the frontend production build (`tsc -b && vite build`) to verify the
 * agent's UI edits compile. Returns ok + tail-truncated combined output (the
 * tail is where tsc/vite errors land — handy to feed back to the agent).
 */
export function buildFrontend(
  repoRoot: string,
  signal?: AbortSignal
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('npm', ['-w', '@daily-planner/frontend', 'run', 'build'], {
      cwd: path.join(repoRoot, 'viewer'),
      shell: IS_WIN,
      env: process.env
    });

    let buf = '';
    const collect = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      if (buf.length > 200_000) buf = buf.slice(-120_000); // cap memory
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const onAbort = () => {
      try {
        if (IS_WIN && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']);
        else child.kill('SIGKILL');
      } catch {
        /* gone */
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      resolve({ ok: false, output: `构建进程启动失败:${err.message}` });
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      const tail = buf.length > 4000 ? '…\n' + buf.slice(-4000) : buf;
      resolve({ ok: code === 0, output: tail.trim() || `(exit ${code})` });
    });
  });
}
