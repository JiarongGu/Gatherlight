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

// Lantern-paper faces — kept in sync with the CSS variables in styles.css.
const FONT_BODY =
  '"Instrument Sans", "Noto Sans SC", system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
const FONT_MONO = '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

/** antd token overrides per mode — kept in sync with the CSS variables in styles.css. */
export function antdThemeConfig(mode: ThemeMode): ThemeConfig {
  const dark = mode === 'dark';
  const accent = dark ? '#e6a057' : '#b85c1c';
  return {
    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: accent,
      colorLink: accent,
      colorInfo: accent,
      colorBgBase: dark ? '#15110d' : '#f3ecdf',
      colorBgContainer: dark ? '#1e1811' : '#fbf6ec',
      colorBgElevated: dark ? '#281f17' : '#fbf6ec',
      colorBorder: dark ? '#382c22' : '#e2d6c0',
      colorBorderSecondary: dark ? '#271f18' : '#eadfcd',
      colorText: dark ? '#f1e9db' : '#2b2119',
      colorTextSecondary: dark ? '#c6b9a4' : '#5c5044',
      colorTextTertiary: dark ? '#8d8069' : '#8a7d64',
      borderRadius: 11,
      wireframe: false,
      fontFamily: FONT_BODY,
      fontFamilyCode: FONT_MONO
    },
    components: {
      Menu: {
        itemSelectedBg: dark ? 'rgba(230,160,87,0.16)' : 'rgba(184,92,28,0.12)',
        itemSelectedColor: accent,
        itemHoverColor: accent,
        itemBorderRadius: 9,
        activeBarBorderWidth: 0
      },
      Card: { borderRadiusLG: 16 },
      Modal: { borderRadiusLG: 18 },
      Button: { borderRadius: 10, fontWeight: 500 },
      Tooltip: { borderRadius: 9 }
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
