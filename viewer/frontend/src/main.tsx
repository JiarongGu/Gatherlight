import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
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
