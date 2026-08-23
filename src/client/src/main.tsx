import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
// Self-hosted Latin faces (bundled → served from wwwroot, no CDN, works offline).
// CJK glyphs fall back to the OS font (PingFang / YaHei / system serif) — bundling
// full Noto CJK would add multiple MB, and every target machine already ships CJK.
import '@fontsource/fraunces/400.css';
import '@fontsource/fraunces/500.css';
import '@fontsource/fraunces/600.css';
import '@fontsource/fraunces/700.css';
import '@fontsource/instrument-sans/400.css';
import '@fontsource/instrument-sans/500.css';
import '@fontsource/instrument-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import { App } from './App';
import { AuthGate } from './screens';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { ThemeProvider, useTheme, antdThemeConfig } from './lib/theme';
import './styles.css';
// Area stylesheets, lifted out of styles.css once it passed 3400 lines with every area interleaved.
//
// IMPORTED AFTER styles.css, and that is not arbitrary: each of these was CLOSED when it moved — every
// rule for its selectors was inside the block and nothing else was — so no rule here can be reordered
// against a rule there, and the cascade is unchanged. Adding a rule for one of these areas back into
// styles.css, or a rule for a DIFFERENT area into one of these, silently breaks that guarantee.
//
// Two compound selectors DELIBERATELY stayed behind — `.leaflet-tooltip.map-tip` (a Leaflet override)
// and `.mng-view.jobs .jobs-toolbar` (console layout). Each is higher-specificity and has no
// counterpart in its partial, so order cannot matter; both files say so at the top. Read that note
// before adding a rule for either selector.
//
// Only the self-contained areas moved. res · eval · set · cmdk are still interleaved through styles.css
// and cannot be lifted without reordering equal-specificity rules across the app; see the CSS note in
// docs/ before attempting it.
import './styles/map.css';
import './styles/grant.css';
import './styles/kb.css';
import './styles/jobs.css';
import './styles/memory-recall.css';

function ThemedApp() {
  const { mode } = useTheme();
  return (
    <ConfigProvider locale={zhCN} theme={antdThemeConfig(mode)}>
      <AntApp>
        <AuthGate>
          <ErrorBoundary>
            <App />
          </ErrorBoundary>
        </AuthGate>
      </AntApp>
    </ConfigProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <ThemedApp />
    </ThemeProvider>
  </React.StrictMode>
);
