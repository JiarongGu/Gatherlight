import type { PlanFile } from './collectFiles';

// Map destination slug → 中文 display name. Unknown destinations fall back to
// capitalised slug.
export const DESTINATION_LABEL: Record<string, string> = {
  japan: '日本',
  iceland: '冰岛',
  korea: '韩国',
  thailand: '泰国',
  vietnam: '越南',
  taiwan: '台湾',
  hongkong: '香港',
  singapore: '新加坡',
  europe: '欧洲',
  italy: '意大利',
  france: '法国',
  spain: '西班牙',
  germany: '德国',
  usa: '美国',
  uk: '英国',
  newzealand: '新西兰',
  australia: '澳大利亚'
};

export function destinationDisplayName(slug: string): string {
  return DESTINATION_LABEL[slug] ?? slug.charAt(0).toUpperCase() + slug.slice(1);
}

export interface TripUnit {
  slug: string;
  trip?: PlanFile;
  budget?: PlanFile;
  packing?: PlanFile;
  visa?: PlanFile; // plans/visa/<slug>/README.md if present
}

export interface TripVariant extends TripUnit {
  yearMonth: string;
  variantNumber: number;
  themeHint?: string;
}

export interface DestinationGroup {
  destination: string; // e.g. "japan"
  displayName: string; // e.g. "日本"
  year: string; // e.g. "2026" (blank if variants span years)
  variants: TripVariant[];
}

export function parseSlug(
  slug: string
): { yearMonth: string; year: string; destination: string } | null {
  const m = slug.match(/^(\d{4})-(\d{2})-(.+)$/);
  if (!m) return null;
  return { yearMonth: `${m[1]}-${m[2]}`, year: m[1], destination: m[3] };
}

/** Extract a 1-2 word theme from a trip title: text after "—" / " - ". */
export function extractShortTheme(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const m = title.match(/(?:—| - )\s*(.+)$/);
  if (!m) return undefined;
  const after = m[1]?.trim() ?? '';
  const first = after.split(/[·(（]/)[0]?.trim();
  if (!first) return undefined;
  return first.slice(0, 12);
}

/**
 * Group trips + paired budget/packing/visa into "trip units" by full slug, then
 * group units by destination. Returns the destination groups (each with sorted,
 * numbered variants) and the set of file paths consumed into a trip unit (so the
 * sidebar can keep orphan budgets/packing in their standalone categories).
 */
export function buildDestinationGroups(files: PlanFile[]): {
  destinationGroups: DestinationGroup[];
  consumedPaths: Set<string>;
} {
  const unitMap = new Map<string, TripUnit>();
  for (const f of files) {
    if (!f.subgroup) continue;
    if (!['Trips', 'Budgets', 'Packing', 'Visa'].includes(f.category)) continue;
    const unitKey = f.category === 'Visa' ? f.subgroup : f.name;
    const unit = unitMap.get(unitKey) ?? { slug: unitKey };
    if (f.category === 'Trips') unit.trip = f;
    else if (f.category === 'Budgets') unit.budget = f;
    else if (f.category === 'Packing') unit.packing = f;
    else if (f.category === 'Visa' && f.name === 'README') unit.visa = f;
    unitMap.set(unitKey, unit);
  }

  const consumedPaths = new Set<string>();
  const destBuckets = new Map<string, DestinationGroup>();
  for (const unit of unitMap.values()) {
    if (!unit.trip) continue; // orphan budgets/packing/visa stay standalone
    const parsed = parseSlug(unit.slug);
    if (!parsed) continue;
    consumedPaths.add(unit.trip.path);
    if (unit.budget) consumedPaths.add(unit.budget.path);
    if (unit.packing) consumedPaths.add(unit.packing.path);
    if (unit.visa) consumedPaths.add(unit.visa.path);

    const grp = destBuckets.get(parsed.destination) ?? {
      destination: parsed.destination,
      displayName: destinationDisplayName(parsed.destination),
      year: parsed.year,
      variants: []
    };
    grp.variants.push({
      ...unit,
      yearMonth: parsed.yearMonth,
      variantNumber: 0,
      themeHint: extractShortTheme(unit.trip.title)
    });
    destBuckets.set(parsed.destination, grp);
  }

  const destinationGroups: DestinationGroup[] = [];
  for (const grp of destBuckets.values()) {
    grp.variants.sort((a, b) => a.yearMonth.localeCompare(b.yearMonth));
    grp.variants.forEach((v, i) => {
      v.variantNumber = i + 1;
    });
    const years = new Set(grp.variants.map((v) => v.yearMonth.slice(0, 4)));
    if (years.size > 1) grp.year = '';
    destinationGroups.push(grp);
  }
  destinationGroups.sort((a, b) => a.destination.localeCompare(b.destination));
  return { destinationGroups, consumedPaths };
}

export interface TripMeta {
  startDate?: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
  days?: number;
  travelers?: number;
}

function monthIndex(yyyymm: string): number {
  const y = parseInt(yyyymm.slice(0, 4), 10);
  const m = parseInt(yyyymm.slice(5, 7), 10);
  return y * 12 + (m - 1);
}

// Itinerary day headings, e.g. `### 🛫 Day 1 — 2026-09-05(Sat)— …`. Same
// markdown convention TripDayNav.tsx navigates by (DAY_RE/DATE_RE). Anchored to
// `#{2,4}` headings so table rows mentioning "Day 16" don't match.
const DAY_HEADING_RE = /^#{2,4}\s[^\n]*?\bDay\s+\d+\b[^\n]*?(\d{4}-\d{2}-\d{2})/gm;

/**
 * Best-effort metadata for a trip card. `Day N — YYYY-MM-DD` headings are
 * authoritative for the itinerary range when present. Only when a file has no
 * day headings do we fall back to a full-text scan, keeping YYYY-MM-DD values
 * **within ±1 month of the trip's anchor month** (the slug's YYYY-MM) to avoid
 * stray dates (traveler birthdates, citation "verified" dates, booking
 * deadlines). Everything is optional — the card degrades to the slug month
 * when nothing fits.
 */
export function extractTripMeta(content: string, anchorYearMonth: string): TripMeta {
  const meta: TripMeta = {};
  let dates = [...content.matchAll(DAY_HEADING_RE)].map((m) => m[1]);
  if (!dates.length) {
    const anchor = monthIndex(anchorYearMonth);
    dates = [...content.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)]
      .map((m) => m[1])
      .filter((d) => Math.abs(monthIndex(d.slice(0, 7)) - anchor) <= 1);
  }
  if (dates.length) {
    const sorted = [...new Set(dates)].sort();
    meta.startDate = sorted[0];
    meta.endDate = sorted[sorted.length - 1];
    const a = new Date(meta.startDate + 'T00:00:00');
    const b = new Date(meta.endDate + 'T00:00:00');
    const diff = Math.round((b.getTime() - a.getTime()) / 86400000);
    if (Number.isFinite(diff) && diff >= 0) meta.days = diff + 1;
  }
  const t = content.match(/(\d+)\s*(?:人|位|adults?|pax|大人)/i);
  if (t) meta.travelers = parseInt(t[1], 10);
  return meta;
}
