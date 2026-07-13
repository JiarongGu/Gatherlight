import { Tooltip } from '@/ui/atoms';
import {
  MenuOutlined,
  OrderedListOutlined,
  SearchOutlined,
  RobotOutlined,
  BulbOutlined,
  BulbFilled,
  CompassOutlined
} from '@ant-design/icons';
import type { ReactNode } from 'react';
import type { ThemeMode } from '@/lib/theme';

interface Props {
  isMobile: boolean;
  hasToc: boolean;
  mode: ThemeMode;
  onHome: () => void;
  onOpenPalette: () => void;
  onToggleTheme: () => void;
  onOpenChat: () => void;
  onMenu: () => void;
  onToc: () => void;
  exportNode?: ReactNode;
}

export function TopBar({
  isMobile,
  hasToc,
  mode,
  onHome,
  onOpenPalette,
  onToggleTheme,
  onOpenChat,
  onMenu,
  onToc,
  exportNode
}: Props) {
  return (
    <div className="topbar no-print">
      {isMobile && (
        <button className="topbar-icon-btn" onClick={onMenu} aria-label="打开文件树">
          <MenuOutlined />
        </button>
      )}

      <button className="topbar-brand" onClick={onHome} aria-label="回到首页">
        <CompassOutlined />
        <span className="topbar-brand-text">日常规划</span>
      </button>

      <button className="topbar-search" onClick={onOpenPalette}>
        <SearchOutlined />
        <span className="topbar-search-text">搜索全部计划…</span>
        <kbd className="topbar-kbd">⌘K</kbd>
      </button>

      <div className="topbar-actions">
        {exportNode}
        <Tooltip title={mode === 'dark' ? '切换亮色' : '切换暗色'}>
          <button className="topbar-icon-btn" onClick={onToggleTheme} aria-label="切换主题">
            {mode === 'dark' ? <BulbOutlined /> : <BulbFilled />}
          </button>
        </Tooltip>
        <Tooltip title="Claude 助手">
          <button className="topbar-icon-btn" onClick={onOpenChat} aria-label="Claude 助手">
            <RobotOutlined />
          </button>
        </Tooltip>
        {isMobile && hasToc && (
          <button className="topbar-icon-btn" onClick={onToc} aria-label="打开目录">
            <OrderedListOutlined />
          </button>
        )}
      </div>
    </div>
  );
}
