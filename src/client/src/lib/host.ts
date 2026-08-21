// host.ts — the ONE seam between this web client and the WebView2 desktop host.
//
// The desktop app (src/server/Gatherlight.Host/AppHost.cs) injects `window.__gatherlightHost` and
// dispatches string messages posted through `chrome.webview`. That is the app's only channel for
// anything a browser cannot do: opening a folder, restarting the server, a native file dialog,
// leaving the app. It had been re-implemented at three call sites with three different levels of
// care — typed with a try/catch in Manage, typed without one in SetupWizard, and `(window as any)`
// in MigrationOverlay — so the client's own contract with its host existed nowhere.
//
// TWO GRAMMARS, NOT FREE-FORM STRINGS. Two of the messages carry parameters, and both parsers live
// in C#: `theme:light|dark`, and `close:<choice>[:remember]` which AppHost splits on ':' and reads
// positionally. Interpolating those at a JSX call site rebuilds a remote parser's grammar inside a
// component; `hostTheme` and `hostClose` are the reason a caller never types a colon.
//
// DRIFT IS CHECKED, because the compiler cannot see across the wire and the failure is silent: a
// renamed action leaves a button that posts a message nothing handles, and `TryGetWebMessageAsString`
// on the far side simply drops it. `node devtools/dev.mjs check-host-actions` asserts HostAction
// against AppHost.cs's switch.

/** True when running inside the desktop host — false in any plain browser tab. */
export const inHost =
  typeof window !== 'undefined' &&
  (window as { __gatherlightHost?: boolean }).__gatherlightHost === true;

/**
 * Every parameterless message AppHost.cs handles. Kept in the same order as its switch so the two
 * lists can be read side by side. `restart` is AppHost's own alias for `serverRestart`; it is listed
 * because the check compares against the switch, and deliberately not used.
 */
export type HostAction =
  | 'openPlanner'
  | 'openDataFolder'
  | 'openLogs'
  | 'restart'
  | 'serverRestart'
  | 'serverStart'
  | 'serverStop'
  | 'applyUpdate'
  | 'exit'
  | 'exportMemory'
  | 'importMemory'
  | 'exportBackup'
  | 'importBackup';

/** What the host may push back at us (AppHost.WebToast / the ✕ close prompt). */
export type HostMessage =
  | { type: 'toast'; kind?: 'ok' | 'err'; text?: string }
  | { type: 'close-prompt' };

function webview() {
  try {
    return (window as unknown as {
      chrome?: {
        webview?: {
          postMessage(m: string): void;
          addEventListener?: (t: string, h: (e: { data: unknown }) => void) => void;
          removeEventListener?: (t: string, h: (e: { data: unknown }) => void) => void;
        };
      };
    }).chrome?.webview;
  } catch {
    return undefined;
  }
}

/**
 * Post a raw message. Private on purpose — the exported functions below are the vocabulary, so a
 * caller cannot invent an action or misspell a grammar.
 *
 * Returns whether it was handed to the host, which lets a caller fall back in a browser instead of
 * rendering a control that silently does nothing.
 */
function post(message: string): boolean {
  const w = webview();
  if (!w) return false;
  try {
    w.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

/** Ask the host to perform a native action. False in a plain browser — nothing happened. */
export function hostPost(action: HostAction): boolean {
  return post(action);
}

/** Mirror the console's theme onto the host's native window + tray menu. */
export function hostTheme(mode: 'light' | 'dark'): boolean {
  return post(`theme:${mode}`);
}

/**
 * Answer the host's ✕ close prompt. `remember` persists the choice as HostCloseAction, and AppHost
 * ignores it for 'cancel' — mirrored here so the two cannot disagree about what was stored.
 */
export function hostClose(choice: 'tray' | 'exit' | 'cancel', remember = false): boolean {
  return post(`close:${choice}${remember && choice !== 'cancel' ? ':remember' : ''}`);
}

/** Read the theme the document is currently rendering, in the host's vocabulary. */
export function documentTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

/**
 * Subscribe to host→web messages. Returns an unsubscribe function, and is a no-op outside the host,
 * so a caller needs no `inHost` guard of its own.
 */
export function onHostMessage(handler: (m: HostMessage) => void): () => void {
  const w = webview();
  if (!inHost || !w?.addEventListener) return () => {};
  const listener = (e: { data: unknown }) => {
    const d = e.data as { type?: string } | null;
    if (d?.type === 'toast' || d?.type === 'close-prompt') handler(d as HostMessage);
  };
  w.addEventListener('message', listener);
  return () => w.removeEventListener?.('message', listener);
}
