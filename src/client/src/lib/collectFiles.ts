// Data layer — loads the plan tree + trip assets from the Gatherlight server.
// (Previously a build-time import.meta.glob over the repo; now the data lives in the
// server's data folder and arrives over /api, so edits show up without a rebuild.)

export interface PlanFile {
  path: string;        // relative to the data root, e.g. "plans/trips/2026-08-kyoto.md"
  category: string;    // top-level group label, e.g. "Trips"
  subgroup?: string;   // for daily/weekly, the year; for trips/budgets/packing, the destination slug
  name: string;        // filename without .md
  title: string;       // first H1 in the file, or filename if none
  content: string;     // raw markdown
}

// Non-markdown assets paired with a trip slug (visa PDFs, visa data JSON, etc.).
export interface TripAsset {
  path: string;        // relative to the data root, e.g. "plans/visa/2026-08-kyoto/applicant-itinerary-filled.pdf"
  slug: string;        // trip slug, e.g. "2026-08-kyoto"
  category: 'visa';    // future: 'booking', 'insurance', etc.
  kind: 'pdf' | 'json';
  filename: string;    // basename, e.g. "applicant-itinerary-filled.pdf"
  url: string;         // browser-loadable URL (/api/assets/...)
  sizeBytes?: number;  // for display
}

interface ApiPlanFile {
  path: string;
  category: string;
  subgroup?: string | null;
  name: string;
  title: string;
  content?: string | null;
}

interface ApiTripAsset {
  path: string;
  slug: string;
  category: string;
  kind: string;
  filename: string;
  url: string;
  sizeBytes?: number;
}

export interface PlanData {
  files: PlanFile[];
  tripAssets: TripAsset[];
}

/**
 * One startup request with inlined content (family-scale data — one round-trip beats
 * eighty). The plan index itself is maintained server-side (SQLite, zero-LLM).
 */
export async function loadPlanData(): Promise<PlanData> {
  const res = await fetch('/api/plans?content=1');
  if (!res.ok) throw new Error(`加载计划失败 (${res.status})`);
  const data = (await res.json()) as { files: ApiPlanFile[]; assets: ApiTripAsset[] };

  const files: PlanFile[] = data.files.map((f) => ({
    path: f.path,
    category: f.category,
    subgroup: f.subgroup ?? undefined,
    name: f.name,
    title: f.title,
    content: f.content ?? ''
  }));

  // sort: newest-looking names first within each category (legacy viewer order)
  files.sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return b.name.localeCompare(a.name);
  });

  const tripAssets: TripAsset[] = data.assets
    .filter((a) => a.category === 'visa')
    .map((a) => ({
      path: a.path,
      slug: a.slug,
      category: 'visa' as const,
      kind: a.kind === 'pdf' ? ('pdf' as const) : ('json' as const),
      filename: a.filename,
      url: a.url,
      sizeBytes: a.sizeBytes
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  return { files, tripAssets };
}
