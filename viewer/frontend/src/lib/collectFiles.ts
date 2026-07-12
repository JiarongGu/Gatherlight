export interface PlanFile {
  path: string;        // relative to repo root, e.g. "plans/trips/2026-08-kyoto.md"
  category: string;    // top-level group label, e.g. "Trips"
  subgroup?: string;   // for daily/weekly, the year; for trips/budgets/packing, the destination slug
  name: string;        // filename without .md
  title: string;       // first H1 in the file, or filename if none
  content: string;     // raw markdown
}

// Non-markdown assets paired with a trip slug (visa PDFs, visa data JSON, etc.).
// Bundled by Vite as static assets so the viewer can offer direct downloads.
export interface TripAsset {
  path: string;        // relative to repo root, e.g. "plans/visa/2026-08-kyoto/applicant-itinerary-filled.pdf"
  slug: string;        // trip slug, e.g. "2026-08-kyoto"
  category: 'visa';    // future: 'booking', 'insurance', etc.
  kind: 'pdf' | 'json';
  filename: string;    // basename, e.g. "applicant-itinerary-filled.pdf"
  url: string;         // browser-loadable URL (Vite asset URL or data URL)
  sizeBytes?: number;  // for display
}

// User-facing content (root level)
const plansRaw = import.meta.glob('../../../../plans/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>;

const householdRaw = import.meta.glob('../../../../household/*.md', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>;

// AI infrastructure (.claude/) — collapsed by default in sidebar
const templatesRaw = import.meta.glob('../../../../.claude/templates/*.md', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>;

const workflowsRaw = import.meta.glob('../../../../.claude/workflows/*.md', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>;

const indexRaw = import.meta.glob(
  ['../../../../.claude/AI_GUIDE.md', '../../../../.claude/KEYWORDS_INDEX.md', '../../../../.claude/keywords/*.md'],
  { query: '?raw', import: 'default', eager: true }
) as Record<string, string>;

const rulesRaw = import.meta.glob('../../../../.claude/rules/*.md', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>;

const skillsRaw = import.meta.glob('../../../../.claude/skills/*/SKILL.md', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>;

// Dev knowledge set — 系统模式 (UI iteration) domain index + rules + docs.
const devRaw = import.meta.glob('../../../../.claude/dev/*.md', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>;

// Trip-paired non-markdown assets (visa PDFs + data JSON).
// `?url` makes Vite emit the file as a static asset + import its URL.
const visaPdfUrls = import.meta.glob('../../../../plans/visa/*/*.pdf', {
  query: '?url',
  import: 'default',
  eager: true
}) as Record<string, string>;

const visaJsonRaw = import.meta.glob('../../../../plans/visa/*/*.json', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>;

function normalisePath(viteKey: string): string {
  // strip the leading "../../../" so the path is relative to repo root
  return viteKey.replace(/^(\.\.\/)+/, '');
}

function extractTitle(content: string, fallback: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}

// For plans/trips/YYYY-MM-<destination>.md → destination is the subgroup
// (same for paired budgets/packing — slugs match so files appear under same destination)
function extractDestinationSlug(filename: string): string | undefined {
  const stripped = filename.replace(/\.md$/, '');
  const m = stripped.match(/^\d{4}-\d{2}-(.+)$/);
  return m?.[1];
}

function categorise(path: string): { category: string; subgroup?: string } {
  const filename = path.split('/').pop() ?? '';

  // Plans (user-facing)
  if (path.startsWith('plans/trips/')) {
    return { category: 'Trips', subgroup: extractDestinationSlug(filename) };
  }
  if (path.startsWith('plans/daily/')) {
    return { category: 'Daily', subgroup: filename.slice(0, 4) };
  }
  if (path.startsWith('plans/weekly/')) {
    return { category: 'Weekly', subgroup: filename.slice(0, 4) };
  }
  if (path.startsWith('plans/budgets/')) {
    return { category: 'Budgets', subgroup: extractDestinationSlug(filename) };
  }
  if (path.startsWith('plans/packing/')) {
    return { category: 'Packing', subgroup: extractDestinationSlug(filename) };
  }
  if (path.startsWith('plans/visa/')) {
    // plans/visa/<slug>/<file>.md — slug is the parent folder, not the filename
    const parts = path.split('/');
    const slug = parts[2]; // plans / visa / <slug> / file
    return { category: 'Visa', subgroup: slug };
  }

  // Household (root-level, user-facing)
  if (path.startsWith('household/')) return { category: 'Household' };

  // AI infrastructure (.claude/, AI's knowledge base — collapsed by default)
  if (path.startsWith('.claude/templates/')) return { category: 'Templates' };
  if (path.startsWith('.claude/workflows/')) return { category: 'Workflows' };
  if (
    path.startsWith('.claude/keywords/') ||
    path === '.claude/AI_GUIDE.md' ||
    path === '.claude/KEYWORDS_INDEX.md'
  ) {
    return { category: 'Index' };
  }
  if (path.startsWith('.claude/rules/')) return { category: 'Rules' };
  if (path.startsWith('.claude/skills/')) return { category: 'Skills' };
  if (path.startsWith('.claude/dev/')) return { category: 'Dev' };

  return { category: 'Other' };
}

/**
 * Collect non-markdown trip assets (visa PDFs + data JSON), grouped by trip slug.
 * Returns paired assets so the viewer can render download links + inline previews
 * when a trip plan is active.
 */
export function collectTripAssets(): TripAsset[] {
  const assets: TripAsset[] = [];

  // PDF URLs (Vite-emitted static asset URLs)
  for (const [viteKey, url] of Object.entries(visaPdfUrls)) {
    const path = normalisePath(viteKey);
    const parts = path.split('/');
    if (parts.length < 4 || parts[0] !== 'plans' || parts[1] !== 'visa') continue;
    const slug = parts[2]!;
    const filename = parts.slice(3).join('/');
    assets.push({
      path,
      slug,
      category: 'visa',
      kind: 'pdf',
      filename,
      url
    });
  }

  // JSON raw contents — encode as data URL so we can download
  for (const [viteKey, raw] of Object.entries(visaJsonRaw)) {
    const path = normalisePath(viteKey);
    const parts = path.split('/');
    if (parts.length < 4 || parts[0] !== 'plans' || parts[1] !== 'visa') continue;
    const slug = parts[2]!;
    const filename = parts.slice(3).join('/');
    const url = `data:application/json;charset=utf-8,${encodeURIComponent(raw)}`;
    assets.push({
      path,
      slug,
      category: 'visa',
      kind: 'json',
      filename,
      url,
      sizeBytes: new Blob([raw]).size
    });
  }

  return assets.sort((a, b) => a.path.localeCompare(b.path));
}

export function collectFiles(): PlanFile[] {
  const all: Record<string, string> = {
    ...plansRaw,
    ...householdRaw,
    ...templatesRaw,
    ...workflowsRaw,
    ...indexRaw,
    ...rulesRaw,
    ...skillsRaw,
    ...devRaw
  };

  const files: PlanFile[] = [];

  for (const [viteKey, content] of Object.entries(all)) {
    const path = normalisePath(viteKey);
    const { category, subgroup } = categorise(path);
    // Skills use SKILL.md as the filename — pull the parent folder for the display name
    const name = path.startsWith('.claude/skills/')
      ? path.split('/').slice(-2, -1)[0]!
      : path.split('/').pop()!.replace(/\.md$/, '');
    const title = extractTitle(content, name);
    files.push({ path, category, subgroup, name, title, content });
  }

  // sort: newest-looking names first within each category
  files.sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return b.name.localeCompare(a.name);
  });

  return files;
}
