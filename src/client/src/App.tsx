import { useMemo, useState, useEffect, useCallback } from 'react';
import { Layout, Grid, App as AntApp } from 'antd';
import { Drawer, Button, Space, Tooltip, CatBadge } from '@/ui/atoms';
import { DownloadOutlined, PrinterOutlined, FilePdfOutlined, CalendarOutlined } from '@ant-design/icons';
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
import { Home, Library, KnowledgeBase, Manage } from '@/screens';
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

// Planner view ⇄ URL. Query params keep the desktop-hosted app on the same surface across reloads
// and let the management console deep-link into it (e.g. `?view=library`, `?path=plans/…`). The
// `/manage` console and `?gallery` surface are separate top-level routes, handled before this.
type PlannerView = { path: string | null; library: boolean; knowledge: boolean };
function readView(): PlannerView {
  const none = { path: null, library: false, knowledge: false };
  if (typeof location === 'undefined') return none;
  const p = new URLSearchParams(location.search);
  const view = p.get('view');
  if (view === 'library') return { ...none, library: true };
  if (view === 'knowledge') return { ...none, knowledge: true };
  const path = p.get('path');
  return { ...none, path: path && path.trim() ? path.trim() : null };
}
function viewToUrl(v: PlannerView): string {
  const p = new URLSearchParams();
  if (v.library) p.set('view', 'library');
  else if (v.knowledge) p.set('view', 'knowledge');
  else if (v.path) p.set('path', v.path);
  const qs = p.toString();
  return qs ? `${location.pathname}?${qs}` : location.pathname;
}

export function App() {
  if (SHOW_GALLERY) return <Gallery />;
  // The desktop management console renders this admin dashboard (WebView2 loads /manage).
  if (typeof location !== 'undefined' && location.pathname.replace(/\/+$/, '') === '/manage') return <Manage />;
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
  const planLoading = planData === null && loadError === null;
  const { mode, toggle } = useTheme();
  const { message } = AntApp.useApp();

  // Initial view comes from the URL (deep-link / reload); default is the Home dashboard.
  const initialView = useMemo(readView, []);
  const [activePath, setActivePath] = useState<string | null>(initialView.path);
  // Two standalone top-level surfaces, distinct from the markdown plan reader: the DB-backed 知识库
  // (Library) and the 智库 (Knowledge Base — the AI-infra corpus). Only one is active at a time.
  const [showLibrary, setShowLibrary] = useState(initialView.library);
  const [showKnowledge, setShowKnowledge] = useState(initialView.knowledge);

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

  // Global ⌘K / Ctrl-K → toggle command palette. (⌘K/Ctrl-K isn't a common text shortcut, but
  // guard against hijacking it while the user is typing in a field or contentEditable.)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Reflect the current planner view in the URL (push a history entry per navigation) so reloads
  // land on the same surface and back/forward work. pushState keeps the pathname (`/`) unchanged, so
  // the `/manage`·`?gallery` route guards above stay stable.
  useEffect(() => {
    const url = viewToUrl({ path: activePath, library: showLibrary, knowledge: showKnowledge });
    if (url !== location.pathname + location.search) window.history.pushState(null, '', url);
  }, [activePath, showLibrary, showKnowledge]);
  // Back/forward → restore the view the URL encodes.
  useEffect(() => {
    const onPop = () => {
      const v = readView();
      setActivePath(v.path);
      setShowLibrary(v.library);
      setShowKnowledge(v.knowledge);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
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
      setShowLibrary(false);
      setShowKnowledge(false);
      if (isMobile) setSidebarOpen(false);
    },
    [isMobile]
  );

  const handleHome = useCallback(() => {
    setActivePath(null);
    setShowLibrary(false);
    setShowKnowledge(false);
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);

  const handleOpenLibrary = useCallback(() => {
    setShowLibrary(true);
    setShowKnowledge(false);
    setActivePath(null);
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);

  const handleOpenKnowledge = useCallback(() => {
    setShowKnowledge(true);
    setShowLibrary(false);
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
      const blocked = err instanceof Error && err.message === 'popup-blocked';
      message.error(
        blocked
          ? '浏览器拦截了弹窗 — 请允许本站弹窗后重试,或改用「打印」。'
          : 'PDF 导出失败 — 请查看控制台,或改用「打印」。'
      );
    } finally {
      setPdfBusy(false);
    }
  }, [active, files, message]);
  const handlePrint = () => window.print();
  // ICS (calendar) is a zero-LLM server export — one all-day event per dated day.
  const handleExportIcs = () => {
    if (!active) return;
    window.open(`/api/plans/ics?path=${encodeURIComponent(active.path)}`, '_blank');
  };

  const exportNode = canExport ? (
    <Space size={4} className="no-print">
      <Tooltip title="导出 PDF — 含行程 / 预算 / 打包 / 家庭背景">
        <Button icon={<FilePdfOutlined />} onClick={handleExportPDF} size="small" type="primary" loading={pdfBusy}>
          {!isMobile && 'PDF'}
        </Button>
      </Tooltip>
      <Tooltip title="导出日历 (.ics) — 每天一个全天事件,可导入 Google/Apple 日历">
        <Button icon={<CalendarOutlined />} onClick={handleExportIcs} size="small" />
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
      onOpenLibrary={handleOpenLibrary}
      libraryActive={showLibrary}
      onOpenKnowledge={handleOpenKnowledge}
      knowledgeActive={showKnowledge}
    />
  );

  const contentNode = showLibrary ? (
    <Library />
  ) : showKnowledge ? (
    <KnowledgeBase files={files} onSelect={handleSelect} />
  ) : active ? (
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
      loading={planLoading}
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
