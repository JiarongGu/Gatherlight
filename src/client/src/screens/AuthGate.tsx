import { useEffect, useState, type ReactNode, type FormEvent } from 'react';

interface Status {
  required: boolean;
  authed: boolean;
}

// Wraps the whole app. When the server reports remote-access protection is on and this client
// isn't authenticated (i.e. a genuinely remote browser — loopback is trusted server-side), it
// shows a token prompt instead of the app. Local dev + the desktop host never see it.
export function AuthGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<'checking' | 'gate' | 'open'>('checking');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const check = async () => {
    try {
      const s: Status = await (await fetch('/api/auth/status')).json();
      setPhase(s.required && !s.authed ? 'gate' : 'open');
    } catch {
      // Server unreachable — let the app render and surface its own load error.
      setPhase('open');
    }
  };
  useEffect(() => {
    check();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: token.trim() }),
      });
      if (res.ok) {
        setToken('');
        await check();
      } else {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? '登录失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (phase === 'checking') return <div className="auth-checking" />;
  if (phase === 'open') return <>{children}</>;

  return (
    <div className="auth-gate">
      <form className="auth-card" onSubmit={submit}>
        <span className="auth-seal">拾</span>
        <h1>拾光 · Gatherlight</h1>
        <p className="auth-sub">此实例已开启远程访问保护,请输入访问令牌以继续。</p>
        <input
          type="password"
          className="auth-input"
          placeholder="访问令牌 · access token"
          value={token}
          autoFocus
          spellCheck={false}
          name="token"
          autoComplete="off"
          aria-label="访问令牌 / access token"
          onChange={(e) => setToken(e.target.value)}
        />
        {error && <div className="auth-err">{error}</div>}
        <button className="auth-btn" type="submit" disabled={busy || !token.trim()}>
          {busy ? '验证中…' : '进入'}
        </button>
        <div className="auth-foot">令牌由服务器管理员设置(settings.json · security.accessToken)。本机访问无需令牌。</div>
      </form>
    </div>
  );
}
