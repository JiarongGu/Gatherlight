import { useMemo } from 'react';
import {
  SearchOutlined,
  CompassOutlined,
  DollarOutlined,
  PaperClipOutlined,
  SafetyCertificateOutlined,
  CalendarOutlined,
  ScheduleOutlined,
  ClockCircleOutlined,
  FileTextOutlined
} from '@ant-design/icons';
import { StatusBadge, type TripStatus } from '@/ui/atoms';
import type { PlanFile } from '@/lib/collectFiles';
import { buildDestinationGroups, extractTripMeta, type TripVariant } from '@/lib/tripGroups';
import { getRecent } from '@/lib/recentFiles';
import { modKeyLabel } from '@/lib/platform';
import { PlanActionsMenu, type ActionTarget } from '@/ui/organisms/PlanActionsMenu';

interface AfterAction {
  (info: { removed?: string[]; renamed?: { from: string; to: string } }): void;
}

interface Props {
  files: PlanFile[];
  onSelect: (path: string) => void;
  onOpenPalette: () => void;
  onAfterAction: AfterAction;
  onAskAI: (message: string) => void;
  loading?: boolean;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function todayStr(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isoWeek(d: Date): string {
  // Standard ISO-8601 week number.
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // Thursday of this week
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const fdDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fdDayNum + 3); // 1st Thursday of year
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${date.getUTCFullYear()}-W${pad(week)}`;
}

interface TripCard {
  variant: TripVariant;
  displayName: string;
  startDate?: string;
  endDate?: string;
  days?: number;
  travelers?: number;
  status: 'upcoming' | 'ongoing' | 'past' | 'undated';
  countdownDays?: number;
}

export function Home({ files, onSelect, onOpenPalette, onAfterAction, onAskAI, loading }: Props) {
  const now = useMemo(() => new Date(), []);
  const today = todayStr(now);
  const week = isoWeek(now);

  const cards = useMemo<TripCard[]>(() => {
    const { destinationGroups } = buildDestinationGroups(files);
    const out: TripCard[] = [];
    for (const g of destinationGroups) {
      for (const v of g.variants) {
        if (!v.trip) continue;
        const meta = extractTripMeta(v.trip.content, v.yearMonth);
        let status: TripCard['status'] = 'undated';
        let countdownDays: number | undefined;
        if (meta.startDate) {
          if (meta.startDate > today) {
            status = 'upcoming';
            countdownDays = Math.round(
              (new Date(meta.startDate + 'T00:00:00').getTime() -
                new Date(today + 'T00:00:00').getTime()) /
                86400000
            );
          } else if (meta.endDate && meta.endDate >= today) {
            status = 'ongoing';
          } else {
            status = 'past';
          }
        }
        out.push({
          variant: v,
          displayName: g.displayName,
          startDate: meta.startDate,
          endDate: meta.endDate,
          days: meta.days,
          travelers: meta.travelers,
          status,
          countdownDays
        });
      }
    }
    // upcoming (soonest first) → ongoing → undated → past (most recent first)
    const rank = { upcoming: 0, ongoing: 1, undated: 2, past: 3 };
    out.sort((a, b) => {
      if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
      return (a.startDate ?? a.variant.yearMonth).localeCompare(b.startDate ?? b.variant.yearMonth);
    });
    return out;
  }, [files, today]);

  const todayFile = useMemo(
    () => files.find((f) => f.category === 'Daily' && f.name === today),
    [files, today]
  );
  const weekFile = useMemo(
    () => files.find((f) => f.category === 'Weekly' && f.name === week),
    [files, week]
  );

  const recent = useMemo(
    () => getRecent().map((p) => files.find((f) => f.path === p)).filter((f): f is PlanFile => !!f),
    [files]
  );

  return (
    <div className="home">
      <div className="home-hero">
        <h1>日常规划</h1>
        <p className="home-sub">家庭旅行 · 日程 · 预算 · 打包 · 一处查阅</p>
        <button className="home-search" onClick={onOpenPalette}>
          <SearchOutlined />
          <span>搜索全部计划…</span>
          <kbd>{modKeyLabel}</kbd>
        </button>
      </div>

      {loading && files.length === 0 && (
        <section className="home-section" aria-hidden="true">
          <div className="home-skel-title sk-shimmer" />
          <div className="home-grid">
            {Array.from({ length: 3 }).map((_, i) => (
              <div className="trip-card home-skel-card" key={i}>
                <div className="home-skel-line lg sk-shimmer" />
                <div className="home-skel-line sm sk-shimmer" />
                <div className="home-skel-line sm sk-shimmer" style={{ width: '40%' }} />
                <div className="home-skel-chips">
                  <span className="sk-shimmer" /><span className="sk-shimmer" />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {!loading && files.length === 0 && (
        <section className="home-section">
          <div className="home-firstrun">
            <div className="home-firstrun-seal">拾</div>
            <h2>欢迎使用拾光 · Gatherlight</h2>
            <p>
              还没有任何计划。用 AI 助手开始 —— 用大白话说要规划什么(旅行 / 日程 / 预算 / 打包),
              它会按你的家庭情况拟一份给你看,你审核后自动落库。
            </p>
            <div className="home-firstrun-actions">
              <button className="home-firstrun-cta" onClick={() => onAskAI('')}>
                <CompassOutlined /> 打开 AI 助手开始规划
              </button>
              <button className="home-firstrun-alt" onClick={onOpenPalette}>
                <SearchOutlined /> 搜索 / 浏览
              </button>
            </div>
          </div>
        </section>
      )}

      {cards.length > 0 && (
        <section className="home-section">
          <h2 className="home-section-title">
            <CompassOutlined /> 旅行
          </h2>
          <div className="home-grid">
            {cards.map((c) => (
              <TripCardView
                key={c.variant.slug}
                card={c}
                displayName={c.displayName}
                onSelect={onSelect}
                onAfterAction={onAfterAction}
                onAskAI={onAskAI}
              />
            ))}
          </div>
        </section>
      )}

      {(todayFile || weekFile) && (
        <section className="home-section">
          <h2 className="home-section-title">
            <ClockCircleOutlined /> 当下
          </h2>
          <div className="home-quick">
            {todayFile && (
              <button className="home-quick-item" onClick={() => onSelect(todayFile.path)}>
                <CalendarOutlined />
                <span>今日 · {today}</span>
              </button>
            )}
            {weekFile && (
              <button className="home-quick-item" onClick={() => onSelect(weekFile.path)}>
                <ScheduleOutlined />
                <span>本周 · {week}</span>
              </button>
            )}
          </div>
        </section>
      )}

      {recent.length > 0 && (
        <section className="home-section">
          <h2 className="home-section-title">
            <ClockCircleOutlined /> 最近查看
          </h2>
          <div className="home-recent">
            {recent.map((f) => (
              <button key={f.path} className="home-recent-item" onClick={() => onSelect(f.path)}>
                <FileTextOutlined />
                <span className="home-recent-title">{f.title}</span>
                <span className="home-recent-path">{f.path}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function statusBadge(c: TripCard): { text: string; status: TripStatus } | null {
  switch (c.status) {
    case 'upcoming':
      return { text: c.countdownDays === 0 ? '今天出发' : `还有 ${c.countdownDays} 天`, status: 'upcoming' };
    case 'ongoing':
      return { text: '进行中', status: 'ongoing' };
    case 'past':
      return { text: '已结束', status: 'past' };
    default:
      return null;
  }
}

function TripCardView({
  card,
  displayName,
  onSelect,
  onAfterAction,
  onAskAI
}: {
  card: TripCard;
  displayName: string;
  onSelect: (p: string) => void;
  onAfterAction: AfterAction;
  onAskAI: (message: string) => void;
}) {
  const v = card.variant;
  const badge = statusBadge(card);
  const target: ActionTarget | null = v.trip
    ? {
        kind: 'trip',
        slug: v.slug,
        displayName,
        tripPath: v.trip.path,
        tripTitle: v.trip.title,
        deletePaths: [v.trip, v.budget, v.packing].filter((f) => !!f).map((f) => f!.path),
        visaDir: v.visa ? `plans/visa/${v.slug}` : undefined
      }
    : null;
  const month = parseInt(v.yearMonth.slice(5, 7), 10);
  const dateLine =
    card.startDate && card.endDate
      ? `${card.startDate} → ${card.endDate}`
      : `${v.yearMonth.slice(0, 4)} 年 ${month} 月`;
  const facts = [
    card.days ? `${card.days} 天` : null,
    card.travelers ? `${card.travelers} 人` : null,
    v.themeHint || null
  ].filter(Boolean);

  return (
    <div className={`trip-card ${card.status}`}>
      <div className="trip-card-head">
        <button
          className="trip-card-title"
          onClick={() => v.trip && onSelect(v.trip.path)}
          disabled={!v.trip}
        >
          {card.displayName}
          {v.variantNumber > 1 ? ` · 方案 ${v.variantNumber}` : ''}
        </button>
        {badge && <StatusBadge status={badge.status} text={badge.text} />}
        {target && (
          <PlanActionsMenu target={target} onAfterAction={onAfterAction} onAskAI={onAskAI} />
        )}
      </div>
      <div className="trip-card-date">{dateLine}</div>
      {facts.length > 0 && <div className="trip-card-facts">{facts.join(' · ')}</div>}
      <div className="trip-card-chips">
        {v.trip && (
          <button className="trip-chip" onClick={() => onSelect(v.trip!.path)}>
            <CompassOutlined /> 行程
          </button>
        )}
        {v.budget && (
          <button className="trip-chip" onClick={() => onSelect(v.budget!.path)}>
            <DollarOutlined /> 预算
          </button>
        )}
        {v.packing && (
          <button className="trip-chip" onClick={() => onSelect(v.packing!.path)}>
            <PaperClipOutlined /> 打包
          </button>
        )}
        {v.visa && (
          <button className="trip-chip" onClick={() => onSelect(v.visa!.path)}>
            <SafetyCertificateOutlined /> 签证
          </button>
        )}
      </div>
    </div>
  );
}
