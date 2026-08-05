/**
 * Compatibility ONLY. Plan documents written before S3a embed the maps as raw HTML
 * (`<div class="trip-map" data-cities="…">`). remark parses those into `html` nodes BEFORE rehype
 * runs, so this plugin can turn them into real map nodes with no raw-HTML rehype stage enabled at
 * all — which is why that stage could be deleted rather than narrowed. Scoped to exactly these two
 * classes; every other raw HTML node renders as escaped text.
 */
const TRIP = /<div\s+class=["']trip-map["']([^>]*)>/i;
const CITY = /<div\s+class=["']city-map["']([^>]*)>/i;
const attr = (s: string, name: string): string | undefined =>
  new RegExp(`${name}=["']([^"']*)["']`, 'i').exec(s)?.[1];

export function remarkLegacyMaps() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (tree: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const visit = (node: any) => {
      if (!node.children) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      node.children = node.children.map((child: any) => {
        if (child.type !== 'html' || typeof child.value !== 'string') { visit(child); return child; }
        const trip = TRIP.exec(child.value);
        if (trip) {
          return mapNode({
            cities: (attr(trip[1], 'data-cities') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
          });
        }
        const city = CITY.exec(child.value);
        if (city) {
          return mapNode({
            // Verbatim: CityMap parses "lat,lng|label" itself (newline/semicolon separated).
            // Reformatting here would break documents already in the wild.
            pointsRaw: attr(city[1], 'data-points') ?? '',
            connect: ['1', 'true'].includes((attr(city[1], 'data-connect') ?? '').toLowerCase()),
            title: attr(city[1], 'data-title'),
          });
        }
        return child;
      });
    };
    visit(tree);
  };
}

// A `legacy-map` element node carrying its config as a data attribute; MarkdownView maps it to the
// Map renderer. Using a custom element name (not `div`) keeps it out of the way of real content.
function mapNode(config: Record<string, unknown>) {
  return {
    type: 'paragraph',
    children: [],
    data: { hName: 'legacy-map', hProperties: { 'data-config': JSON.stringify(config) } },
  };
}
