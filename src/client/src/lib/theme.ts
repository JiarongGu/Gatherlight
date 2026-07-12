import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react';
import { theme as antdTheme, type ThemeConfig } from 'antd';

export type ThemeMode = 'dark' | 'light';

const STORAGE_KEY = 'viewer-theme';

function initialMode(): ThemeMode {
  if (typeof window === 'undefined') return 'dark';
  const saved = window.localStorage.getItem(STORAGE_KEY);
  if (saved === 'dark' || saved === 'light') return saved;
  // First run: seed from system, but default dark (per product decision).
  const prefersLight = window.matchMedia?.('(prefers-color-scheme: light)').matches;
  return prefersLight ? 'light' : 'dark';
}

const FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif';

/** antd token overrides per mode — kept in sync with the CSS variables in styles.css. */
export function antdThemeConfig(mode: ThemeMode): ThemeConfig {
  const dark = mode === 'dark';
  return {
    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: dark ? '#6ea8fe' : '#3b6fe0',
      colorBgBase: dark ? '#0b0d10' : '#f7f8fa',
      colorBgContainer: dark ? '#14171c' : '#ffffff',
      colorBgElevated: dark ? '#1b1f26' : '#ffffff',
      colorBorder: dark ? '#262b34' : '#e3e6eb',
      colorBorderSecondary: dark ? '#1e232b' : '#eef0f3',
      colorText: dark ? '#e8eaed' : '#1a1d22',
      colorTextSecondary: dark ? '#b6bcc6' : '#4a515c',
      colorTextTertiary: dark ? '#7d8694' : '#8a93a0',
      borderRadius: 8,
      fontFamily: FONT
    }
  };
}

interface ThemeContextValue {
  mode: ThemeMode;
  toggle: () => void;
  setMode: (m: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(initialMode);

  useEffect(() => {
    document.documentElement.dataset.theme = mode;
    window.localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  const setMode = useCallback((m: ThemeMode) => setModeState(m), []);
  const toggle = useCallback(
    () => setModeState((m) => (m === 'dark' ? 'light' : 'dark')),
    []
  );

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, toggle, setMode }),
    [mode, toggle, setMode]
  );

  return createElement(ThemeContext.Provider, { value }, children);
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
