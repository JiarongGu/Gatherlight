// Read side of the knowledge library (DB-backed) — verified reference entities the planner reuses.
// Unlike plans (markdown files over /api/plans), this is structured knowledge over /api/library.

export interface LibraryItem {
  id: number;
  kind: string;
  key: string;
  name: string;
  nameLocal?: string | null;
  region?: string | null;
  summary?: string | null;
  url?: string | null;
  imageUrl?: string | null;
  lat?: number | null;
  lng?: number | null;
  tags?: string | null;
  source?: string | null;
  confidence: number;
  verifiedAt?: string | null;
}

export interface Facet {
  value: string;
  count: number;
}

export interface LibraryFacets {
  kinds: Facet[];
  regions: Facet[];
  total: number;
}

export interface LibraryData {
  items: LibraryItem[];
  facets: LibraryFacets;
}

export async function loadLibrary(): Promise<LibraryData> {
  const res = await fetch('/api/library');
  if (!res.ok) throw new Error(`加载知识库失败 (${res.status})`);
  return (await res.json()) as LibraryData;
}

// Chinese labels for the entity kinds (the DB stores english kind slugs).
export const KIND_LABEL: Record<string, string> = {
  attraction: '景点',
  restaurant: '餐厅',
  hotel: '酒店',
  experience: '体验',
  other: '其他'
};
