import { memo, useMemo, useState } from 'react';
import { Menu, Empty } from '@/ui/atoms';
import type { MenuProps } from '@/ui/atoms';
import { useTheme } from '@/lib/theme';
import {
  CompassOutlined,
  CalendarOutlined,
  ScheduleOutlined,
  DollarOutlined,
  ContainerOutlined,
  HomeOutlined,
  FileTextOutlined,
  ApartmentOutlined,
  BookOutlined,
  CheckCircleOutlined,
  ToolOutlined,
  FolderOutlined,
  PaperClipOutlined,
  DatabaseOutlined,
  SafetyCertificateOutlined,
  CodeOutlined,
  ReadOutlined
} from '@ant-design/icons';
import type { PlanFile } from '@/lib/collectFiles';
import { extractSnippet } from '@/lib/markdown';
import { SnippetText } from '@/ui/molecules';
import { buildDestinationGroups } from '@/lib/tripGroups';
import { CATEGORY_LABEL } from '@/lib/categories';
import { PlanActionsMenu, type ActionTarget } from './PlanActionsMenu';

interface Props {
  files: PlanFile[];
  activePath: string | null;
  onSelect: (path: string) => void;
  actionTargetFor: (f: PlanFile) => ActionTarget;
  onAfterAction: (info: { removed?: string[]; renamed?: { from: string; to: string } }) => void;
  onAskAI: (message: string) => void;
  onOpenLibrary: () => void;
  libraryActive: boolean;
}

// Trip grouping (slug parsing, destination labels, variant numbering) lives in
// @/lib/tripGroups — shared with Home. Don't re-implement it here.

// User-facing categories (top-level in sidebar, after the synthetic 旅游 / TripUnits).
const USER_CATEGORY_ORDER = [
  'Daily',
  'Weekly',
  'Household',
  'Budgets',
  'Packing',
  'Other'
];

// AI infrastructure (智库) — grouped under a single collapsible parent.
const KB_CATEGORY_ORDER = ['Dev', 'Templates', 'Workflows', 'Index', 'Rules', 'Skills'];

// Household files have English filenames; show 中文 in the menu.
const HOUSEHOLD_LABEL: Record<string, string> = {
  people: '家庭成员',
  preferences: '偏好',
  constraints: '约束',
  recurring: '周期事务',
  income: '收入',
  expenses: '开销',
  README: '说明'
};

// Sidebar shows standalone (un-paired) budgets/packing with a "(独立)" marker.
const SIDEBAR_LABEL: Record<string, string> = {
  ...CATEGORY_LABEL,
  Budgets: '预算(独立)',
  Packing: '打包(独立)'
};

const CATEGORY_ICON: Record<string, React.ReactNode> = {
  Daily: <CalendarOutlined />,
  Weekly: <ScheduleOutlined />,
  Budgets: <DollarOutlined />,
  Packing: <ContainerOutlined />,
  Household: <HomeOutlined />,
  Dev: <CodeOutlined />,
  Templates: <FileTextOutlined />,
  Workflows: <ApartmentOutlined />,
  Index: <BookOutlined />,
  Rules: <CheckCircleOutlined />,
  Skills: <ToolOutlined />,
  Other: <FolderOutlined />
};

// Memoized: props are referentially stable (files memoized, callbacks
// useCallback'd, activePath only changes on selection), so toggling shell state
// (chat / ⌘K / resize / theme) no longer rebuilds the whole nested menu tree.
export const Sidebar = memo(function Sidebar({
  files,
  activePath,
  onSelect,
  actionTargetFor,
  onAfterAction,
  onAskAI,
  onOpenLibrary,
  libraryActive
}: Props) {
  const { mode } = useTheme();
  const trimmedSearch = ''; // sidebar tree-filter removed; global ⌘K palette is the search
  const isSearchActive = trimmedSearch.length > 0;

  const filtered = useMemo(() => {
    const q = trimmedSearch.toLowerCase();
    if (!q) return files;
    return files.filter(
      (f) =>
        f.name.toLowerCase().includes(q) ||
        f.title.toLowerCase().includes(q) ||
        f.content.toLowerCase().includes(q)
    );
  }, [files, trimmedSearch]);

  // Group trips + paired budget/packing/visa into destination groups. Shared with
  // Home via @/lib/tripGroups (single source of truth for slug parsing + numbering).
  const { destinationGroups, consumedPaths } = useMemo(
    () => buildDestinationGroups(filtered),
    [filtered]
  );

  const filteredRemaining = useMemo(
    () => filtered.filter((f) => !consumedPaths.has(f.path)),
    [filtered, consumedPaths]
  );

  const groupedUser = useMemo(() => {
    const byCat = new Map<string, PlanFile[]>();
    for (const f of filteredRemaining) {
      if (!USER_CATEGORY_ORDER.includes(f.category)) continue;
      const list = byCat.get(f.category) ?? [];
      list.push(f);
      byCat.set(f.category, list);
    }
    return USER_CATEGORY_ORDER
      .filter((cat) => byCat.has(cat))
      .map((cat) => ({ category: cat, files: byCat.get(cat)! }));
  }, [filteredRemaining]);

  const groupedKB = useMemo(() => {
    const byCat = new Map<string, PlanFile[]>();
    for (const f of filteredRemaining) {
      if (!KB_CATEGORY_ORDER.includes(f.category)) continue;
      const list = byCat.get(f.category) ?? [];
      list.push(f);
      byCat.set(f.category, list);
    }
    return KB_CATEGORY_ORDER
      .filter((cat) => byCat.has(cat))
      .map((cat) => ({ category: cat, files: byCat.get(cat)! }));
  }, [filteredRemaining]);

  const kbTotal = useMemo(
    () => groupedKB.reduce((sum, g) => sum + g.files.length, 0),
    [groupedKB]
  );

  const [manualOpenKeys, setManualOpenKeys] = useState<string[]>(() => {
    // Default open: TripUnits + destination groups + all user-facing categories. KB stays collapsed.
    return [
      'cat-TripUnits',
      ...USER_CATEGORY_ORDER.map((c) => `cat-${c}`)
    ];
  });

  const effectiveOpenKeys = isSearchActive
    ? [
        'cat-TripUnits',
        'cat-KB',
        ...destinationGroups.map((g) => `dest-${g.destination}`),
        ...destinationGroups.flatMap((g) => g.variants.map((v) => `tu-${v.slug}`)),
        ...groupedUser.map((g) => `cat-${g.category}`),
        ...groupedKB.map((g) => `cat-${g.category}`)
      ]
    : manualOpenKeys;

  function handleOpenChange(keys: string[]) {
    if (!isSearchActive) {
      setManualOpenKeys(keys);
    }
  }

  function fileMenuItem(f: PlanFile, options: { label?: string; icon?: React.ReactNode } = {}) {
    const snippet = isSearchActive ? extractSnippet(f.content, trimmedSearch) : null;
    const matchedInName =
      isSearchActive &&
      (f.name.toLowerCase().includes(trimmedSearch.toLowerCase()) ||
        f.title.toLowerCase().includes(trimmedSearch.toLowerCase()));
    const displayName = options.label ?? f.name;
    const isPaired = !!options.label; // when label provided, it's a paired file under trip unit
    return {
      key: f.path,
      icon: options.icon,
      label: (
        <div className="side-row">
          <div className="side-row-main" style={{ lineHeight: 1.3 }}>
            <div
              style={{
                fontFamily: isPaired ? 'inherit' : 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: isPaired ? 13 : 12.5
              }}
            >
              {displayName}
            </div>
            {snippet && !matchedInName && <SnippetText snippet={snippet} className="side-snippet" />}
          </div>
          <PlanActionsMenu
            target={actionTargetFor(f)}
            onAfterAction={onAfterAction}
            onAskAI={onAskAI}
            className="side-row-act"
          />
        </div>
      )
    };
  }

  // Build menu: 旅游 (TripUnits) — 3-level nested:
  //   旅游 → 2026-日本 → 方案 1 (8月 关西) → 行程 / 预算 / 打包
  const totalVariants = destinationGroups.reduce((sum, g) => sum + g.variants.length, 0);
  const tripUnitItems =
    destinationGroups.length > 0
      ? [
          {
            key: 'cat-TripUnits',
            icon: <CompassOutlined />,
            label: (
              <span>
                旅游
                <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--muted)' }}>
                  {totalVariants}
                </span>
              </span>
            ),
            children: destinationGroups.map((grp) => ({
              key: `dest-${grp.destination}`,
              label: (
                <span style={{ fontSize: 13, fontWeight: 500 }}>
                  {grp.year ? `${grp.year}-${grp.displayName}` : grp.displayName}
                  <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--muted)' }}>
                    {grp.variants.length}
                  </span>
                </span>
              ),
              children: grp.variants.map((v) => {
                const month = parseInt(v.yearMonth.slice(5, 7), 10);
                const themePart = v.themeHint ? ` ${v.themeHint}` : '';
                const variantLabel = `方案 ${v.variantNumber}(${month}月${themePart})`;
                return {
                  key: `tu-${v.slug}`,
                  label: (
                    <span style={{ fontSize: 12.5, color: 'var(--text)' }}>
                      {variantLabel}
                      <span
                        style={{
                          marginLeft: 6,
                          fontSize: 10,
                          fontFamily: 'ui-monospace, monospace',
                          color: 'var(--muted)'
                        }}
                      >
                        {v.yearMonth}
                      </span>
                    </span>
                  ),
                  children: [
                    v.trip ? fileMenuItem(v.trip, { label: '行程', icon: <CompassOutlined /> }) : null,
                    v.budget ? fileMenuItem(v.budget, { label: '预算', icon: <DollarOutlined /> }) : null,
                    v.packing ? fileMenuItem(v.packing, { label: '打包', icon: <PaperClipOutlined /> }) : null,
                    v.visa ? fileMenuItem(v.visa, { label: '签证', icon: <SafetyCertificateOutlined /> }) : null
                  ].filter((x): x is NonNullable<typeof x> => x !== null)
                };
              })
            }))
          }
        ]
      : [];

  const userCategoryItems: MenuProps['items'] = groupedUser.map(({ category, files: catFiles }) => ({
    key: `cat-${category}`,
    icon: CATEGORY_ICON[category],
    label: (
      <span>
        {SIDEBAR_LABEL[category] ?? category}
        <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--muted)' }}>
          {catFiles.length}
        </span>
      </span>
    ),
    children: catFiles.map((f) =>
      fileMenuItem(f, category === 'Household' ? { label: HOUSEHOLD_LABEL[f.name] ?? f.name } : {})
    )
  }));

  const kbItems: MenuProps['items'] =
    groupedKB.length > 0
      ? [
          {
            key: 'cat-KB',
            icon: <DatabaseOutlined />,
            label: (
              <span style={{ color: 'var(--text-2)' }}>
                智库
                <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--muted)' }}>
                  {kbTotal}
                </span>
                <span style={{ marginLeft: 6, fontSize: 10, fontStyle: 'italic', color: 'var(--muted)' }}>
                  AI 基础设施
                </span>
              </span>
            ),
            children: groupedKB.map(({ category, files: catFiles }) => ({
              key: `cat-${category}`,
              icon: CATEGORY_ICON[category],
              label: (
                <span style={{ color: 'var(--text-2)' }}>
                  {SIDEBAR_LABEL[category] ?? category}
                  <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--muted)' }}>
                    {catFiles.length}
                  </span>
                </span>
              ),
              children: catFiles.map((f) => fileMenuItem(f))
            }))
          }
        ]
      : [];

  const menuItems: MenuProps['items'] = [...tripUnitItems, ...userCategoryItems, ...kbItems];

  const hasContent = destinationGroups.length > 0 || groupedUser.length > 0 || groupedKB.length > 0;

  return (
    <div style={{ padding: '12px 10px 16px' }}>
      {/* 知识库 — the DB-backed knowledge surface, pinned above the markdown plan tree. */}
      <button
        className={`side-lib${libraryActive ? ' active' : ''}`}
        onClick={onOpenLibrary}
        aria-current={libraryActive ? 'page' : undefined}
      >
        <ReadOutlined className="side-lib-icon" />
        <span className="side-lib-text">
          <span className="side-lib-zh">知识库</span>
          <span className="side-lib-en">LIBRARY</span>
        </span>
      </button>
      <div className="side-sep" />
      {!hasContent ? (
        <Empty description="无匹配" style={{ marginTop: 24 }} />
      ) : (
        <Menu
          mode="inline"
          theme={mode}
          items={menuItems}
          selectedKeys={activePath ? [activePath] : []}
          openKeys={effectiveOpenKeys}
          onOpenChange={handleOpenChange}
          onClick={(e) => {
            // Only leaf clicks (file paths) — not group headers
            if (
              !e.key.startsWith('cat-') &&
              !e.key.startsWith('tu-') &&
              !e.key.startsWith('dest-')
            ) {
              onSelect(e.key);
            }
          }}
          inlineIndent={14}
          style={{ background: 'transparent', border: 'none' }}
        />
      )}
    </div>
  );
});
