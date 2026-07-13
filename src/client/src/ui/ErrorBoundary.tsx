import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/**
 * App-level error boundary. A thrown render error (a malformed plan, a bad map, a library glitch)
 * would otherwise white-screen the whole SPA; here it shows a calm, recoverable fallback instead —
 * the user's data is untouched (it lives in the data folder), so a reload almost always recovers.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface it for the console/logs; the data folder is the source of truth, nothing is lost.
    console.error('Gatherlight UI crashed:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="app-error" role="alert">
        <div className="app-error-card">
          <div className="app-error-seal">拾</div>
          <h1>界面遇到问题</h1>
          <p>
            页面出现了一个意外错误。你的数据是安全的(存放在数据文件夹里,未受影响)—— 刷新页面通常即可恢复。
          </p>
          <pre className="app-error-detail">{error.message}</pre>
          <div className="app-error-actions">
            <button className="app-error-btn primary" onClick={() => window.location.reload()}>
              刷新页面
            </button>
            <button className="app-error-btn" onClick={() => this.setState({ error: null })}>
              重试
            </button>
          </div>
        </div>
      </div>
    );
  }
}
