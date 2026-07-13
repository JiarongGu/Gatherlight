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
import { ThemeProvider, useTheme, antdThemeConfig } from './lib/theme';
import './styles.css';

function ThemedApp() {
  const { mode } = useTheme();
  return (
    <ConfigProvider locale={zhCN} theme={antdThemeConfig(mode)}>
      <AntApp>
        <App />
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
