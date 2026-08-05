// The site's own pages — agent-authored `{data}/ui/<name>.json`, listed by the server.
// Writing the file publishes it, so this list IS the menu: there is no second registry that could
// disagree with what is on disk.
import { get } from './apiClient';

/** One row of the site menu. `label`/`order`/`hidden` are already resolved server-side from the
 *  page's own `nav` block (label falls back to the title), so nothing here re-derives them. */
export interface SitePageSummary {
  name: string;
  title: string;
  label: string;
  order: number;
  hidden: boolean;
}

export function loadSitePages(): Promise<SitePageSummary[]> {
  return get<SitePageSummary[]>('/api/ui/pages');
}
