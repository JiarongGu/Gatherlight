import { useMemo, useState, useEffect, useCallback } from 'react';
import { Layout, Grid } from 'antd';
import { Drawer, Button, Space, Tooltip, CatBadge } from '@/ui/atoms';
import { DownloadOutlined, PrinterOutlined, FilePdfOutlined } from '@ant-design/icons';
import {
  Sidebar,
  MarkdownView,
  TripDayNav,
  TOC,
  TripAssets,
  ChatPanel,
  TopBar,
  CommandPalette,
  PlanActionsMenu,
  type ActionTarget
} from '@/ui/organisms';
import { Home } from '@/screens';
import { loadPlanData, type PlanData, type PlanFile, type TripAsset } from './lib/collectFiles';
import { extractHeadings, stripFirstH1 } from './lib/markdown';
import { buildTripExport, downloadAsFile, downloadTripPDF, isTripFile } from './lib/export';
import { pushRecent } from './lib/recentFiles';
import { buildDestinationGroups } from './lib/tripGroups';
import { CATEGORY_LABEL } from './lib/categories';
import { useTheme } from './lib/theme';
import { Gallery } from './gallery/Gallery';

// Dev-only component gallery (the UI agent's L1 verification surface): /?gallery
const SHOW_GALLERY =
  import.meta.env.DEV && typeof location !== 'undefined' && location.search.includes('gallery');

const { Sider, Content } = Layout;
const { useBreakpoint } = Grid;

const EMPTY_FILES: PlanFile[] = [];
const EMPTY_ASSETS: TripAsset[] = [];

export function App() {
  if (SHOW_GALLERY) return <Gallery />;
  // Plan data now arrives from the server (the data folder is server-side) — loaded once at
  // startup; edits land via chat/fs endpoints which re-index server-side.
  const [planData, setPlanData] = useState<PlanData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    loadPlanData().then(setPlanData, (err: unknown) =>
      setLoadError(err instanceof Error ? err.message : String(err))
    );
  }, []);
  const files = planData?.files ?? EMPTY_FILES;
  const tripAssets = planData?.tripAssets ?? EMPTY_ASSETS;
  const { mode, toggle } = useTheme();

  // Land on the Home dashboard (not a raw file).
  const [activePath, setActivePath] = useState<string | null>(null);

  const screens = useBreakpoint();
  const isMobile = !screens.md; // md = 768px

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [chatPrefill, setChatPrefill] = useState<string>('');
  const [chatPrefillNonce, setChatPrefillNonce] = useState(0);

  // Chat drawer width — drag the left edge to resize; persisted like the theme.
  const CHAT_WIDTH_KEY = 'viewer-chat-width';
  const CHAT_WIDTH_MIN = 360;
  const [chatWidth, setChatWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return 480;
    const saved = Number(window.localStorage.getItem(CHAT_WIDTH_KEY));
    return Number.isFinite(saved) && saved >= CHAT_WIDTH_MIN ? saved : 480;
  });
  const startChatResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      // Drive the width imperatively on the drawer wrapper during the drag so we
      // don't re-render the whole shell (Drawer + ChatPanel + reading column) on
      // every pointermove — that React churn was the source of the lag. We also
      // disable the wrapper's width transition while dragging so it tracks the
      // pointer 1:1. State + localStorage are committed once on release.
      const wrapper = e.currentTarget.closest(
        '.ant-drawer-content-wrapper'
      ) as HTMLElement | null;
      const startX = e.clientX;
      const startWidth = chatWidth;
      const max = window.innerWidth * 0.9;
      let latest = startWidth;
      let raf = 0;
      const prevTransition = wrapper?.style.transition ?? '';

      const apply = () => {
        raf = 0;
        if (wrapper) wrapper.style.width = `${latest}px`;
      };
      const onMove = (ev: PointerEvent) => {
        // Drawer sits on the right, so dragging left (smaller clientX) widens it.
        const next = startWidth + (startX - ev.clientX);
        latest = Math.max(CHAT_WIDTH_MIN, Math.min(max, next));
        if (!raf) raf = window.requestAnimationFrame(apply);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (raf) window.cancelAnimationFrame(raf);
        document.body.style.userSelect = '';
        if (wrapper) wrapper.style.transition = prevTransition;
        setChatWidth(latest);
        window.localStorage.setItem(CHAT_WIDTH_KEY, String(Math.round(latest)));
      };

      document.body.style.userSelect = 'none';
      if (wrapper) wrapper.style.transition = 'none';
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [chatWidth]
  );

  const destinationGroups = useMemo(() => buildDestinationGroups(files).destinationGroups, [files]);

  // Build an action target (single file, or a trip unit with its paired files).
  const actionTargetFor = useCallback(
    (file: PlanFile): ActionTarget => {
      if (file.path.startsWith('plans/trips/')) {
        for (const g of destinationGroups) {
          const v = g.variants.find((x) => x.trip?.path === file.path);
          if (v) {
            const deletePaths = [v.trip, v.budget, v.packing]
              .filter((f): f is PlanFile => !!f)
              .map((f) => f.path);
            return {
              kind: 'trip',
              slug: v.slug,
              displayName: g.displayName,
              tripPath: file.path,
              tripTitle: file.title,
              deletePaths,
              visaDir: v.visa ? `plans/visa/${v.slug}` : undefined
            };
          }
        }
      }
      return { kind: 'file', path: file.path, title: file.title };
    },
    [destinationGroups]
  );

  const askAI = useCallback((message: string) => {
    setChatPrefill(message);
    setChatPrefillNonce((n) => n + 1);
    setChatOpen(true);
  }, []);

  const handleAfterAction = useCallback(
    (info: { removed?: string[]; renamed?: { from: string; to: string } }) => {
      if (info.removed && activePath && info.removed.includes(activePath)) setActivePath(null);
      if (info.renamed && activePath === info.renamed.from) setActivePath(info.renamed.to);
    },
    [activePath]
  );

  useEffect(() => {
    if (!isMobile) {
      setSidebarOpen(false);
      setTocOpen(false);
    }
  }, [isMobile]);

  // Global ⌘K / Ctrl-K → toggle command palette.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const active = files.find((f) => f.path === activePath) ?? null;
  // Strip the leading H1 from the body (shown in the page header) so the title
  // isn't doubled; use the stripped body for both rendering and TOC ids.
  const body = useMemo(() => (active ? stripFirstH1(active.content) : ''), [active]);
  const headings = useMemo(() => extractHeadings(body), [body]);
  const hasToc = headings.length >= 2;

  const handleSelect = useCallback(
    (path: string) => {
      pushRecent(path);
      setActivePath(path);
      if (isMobile) setSidebarOpen(false);
    },
    [isMobile]
  );

  const handleHome = useCallback(() => {
    setActivePath(null);
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);

  const handleTocItemClick = () => {
    if (isMobile) setTocOpen(false);
  };

  // ----- export (trip files only) -----
  const canExport = isTripFile(active);
  const [pdfBusy, setPdfBusy] = useState(false);
  const handleExportMarkdown = () => {
    if (!active) return;
    const { filename, content } = buildTripExport(active, files);
    downloadAsFile(filename, content);
  };
  const handleExportPDF = useCallback(async () => {
    if (!active) return;
    setPdfBusy(true);
    try {
      await downloadTripPDF(active, files);
    } catch (err) {
      console.error('PDF export failed:', err);
      alert('PDF 导出失败 — 请打开 console 查看,或改用"打印"按钮。');
    } finally {
      setPdfBusy(false);
    }
  }, [active, files]);
  const handlePrint = () => window.print();

  const exportNode = canExport ? (
    <Space size={4} className="no-print">
      <Tooltip title="导出 PDF — 含行程 / 预算 / 打包 / 家庭背景">
        <Button icon={<FilePdfOutlined />} onClick={handleExportPDF} size="small" type="primary" loading={pdfBusy}>
          {!isMobile && 'PDF'}
        </Button>
      </Tooltip>
      <Tooltip title="单文件 Markdown">
        <Button icon={<DownloadOutlined />} onClick={handleExportMarkdown} size="small" />
      </Tooltip>
      <Tooltip title="打印">
        <Button icon={<PrinterOutlined />} onClick={handlePrint} size="small" />
      </Tooltip>
    </Space>
  ) : null;

  const sidebarNode = (
    <Sidebar
      files={files}
      activePath={activePath}
      onSelect={handleSelect}
      actionTargetFor={actionTargetFor}
      onAfterAction={handleAfterAction}
      onAskAI={askAI}
    />
  );

  const contentNode = active ? (
    <>
      {canExport && <TripDayNav headings={headings} />}
      <div className="reading">
        <header className="main-header">
        <div className="main-header-top">
          <CatBadge label={CATEGORY_LABEL[active.category] ?? active.category} />
          <span className="path">{active.path}</span>
        </div>
        <div className="main-header-row">
          <h1>{active.title}</h1>
          <PlanActionsMenu
            target={actionTargetFor(active)}
            onAfterAction={handleAfterAction}
            onAskAI={askAI}
          />
        </div>
      </header>
      {active.path.startsWith('plans/visa/') && (
        <TripAssets active={active} assets={tripAssets} onSelect={handleSelect} />
      )}
      <MarkdownView source={body} collapsible={canExport} />
      </div>
    </>
  ) : (
    <Home
      files={files}
      onSelect={handleSelect}
      onOpenPalette={() => setPaletteOpen(true)}
      onAfterAction={handleAfterAction}
      onAskAI={askAI}
    />
  );

  if (loadError) {
    return (
      <div style={{ padding: 48, textAlign: 'center', color: 'var(--text)' }}>
        <h2>加载计划数据失败</h2>
        <p style={{ opacity: 0.7 }}>{loadError}</p>
        <p style={{ opacity: 0.5 }}>请确认 Gatherlight 服务正在运行,然后刷新。</p>
      </div>
    );
  }

  return (
    <Layout style={{ height: '100vh' }}>
      <TopBar
        isMobile={isMobile}
        hasToc={hasToc}
        mode={mode}
        onHome={handleHome}
        onOpenPalette={() => setPaletteOpen(true)}
        onToggleTheme={toggle}
        onOpenChat={() => setChatOpen(true)}
        onMenu={() => setSidebarOpen(true)}
        onToc={() => setTocOpen(true)}
        exportNode={exportNode}
      />

      <Layout style={{ flex: 1, minHeight: 0, background: 'var(--bg)' }}>
        {!isMobile && (
          <Sider width={284} className="side side-nav">
            {sidebarNode}
          </Sider>
        )}

        <Content className={canExport ? 'content-scroll has-day-nav' : 'content-scroll'}>
          {contentNode}
        </Content>

        {!isMobile && hasToc && (
          <Sider width={240} className="side side-toc">
            <TOC headings={headings} />
          </Sider>
        )}
      </Layout>

      {/* Mobile drawers */}
      {isMobile && (
        <Drawer
          placement="left"
          width="86%"
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          closable={false}
          styles={{ body: { padding: 0, background: 'var(--surface)' }, content: { background: 'var(--surface)' } }}
        >
          {sidebarNode}
        </Drawer>
      )}
      {isMobile && hasToc && (
        <Drawer
          placement="right"
          width="80%"
          open={tocOpen}
          onClose={() => setTocOpen(false)}
          title="目录"
          styles={{
            body: { padding: 0, background: 'var(--surface)' },
            content: { background: 'var(--surface)' },
            header: { background: 'var(--surface)', borderBottom: '1px solid var(--border)' }
          }}
        >
          <TOC headings={headings} onItemClick={handleTocItemClick} />
        </Drawer>
      )}

      {/* Chat console */}
      <Drawer
        placement="right"
        width={isMobile ? '100%' : chatWidth}
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        forceRender
        title="Claude 助手"
        styles={{
          body: { padding: 0, background: 'var(--surface)', position: 'relative' },
          content: { background: 'var(--surface)' },
          header: { background: 'var(--surface)', borderBottom: '1px solid var(--border)' }
        }}
      >
        {!isMobile && (
          <div
            className="chat-resizer"
            onPointerDown={startChatResize}
            role="separator"
            aria-orientation="vertical"
            aria-label="拖拽调整聊天宽度"
          />
        )}
        <ChatPanel prefill={chatPrefill} prefillNonce={chatPrefillNonce} />
      </Drawer>

      <CommandPalette
        open={paletteOpen}
        files={files}
        onClose={() => setPaletteOpen(false)}
        onSelect={handleSelect}
        onGoHome={handleHome}
        onOpenChat={() => setChatOpen(true)}
      />
    </Layout>
  );
}
