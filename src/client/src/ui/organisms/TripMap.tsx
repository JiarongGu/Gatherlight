import { lazy, Suspense, useMemo } from 'react';
import type { MapMarker } from '@/ui/molecules/MapCanvas';
import { lookupCity } from '@/lib/cityCoords';

// Lazy so the leaflet stack (map + tiles + arrowheads) is fetched only when a route
// actually renders, keeping it out of the initial bundle.
const MapCanvas = lazy(() => import('@/ui/molecules/MapCanvas').then((m) => ({ default: m.MapCanvas })));

interface Props {
  cities: string[]; // ordered slugs, e.g. ["osaka","kanazawa","tokyo"]
  height?: number;
}

/** L2 — inter-city route map. Resolves city slugs → coords, renders the ordered
 * route on the shared L3 MapCanvas (numbered pins + arrow line + fullscreen). */
export function TripMap({ cities, height = 400 }: Props) {
  const markers = useMemo<MapMarker[]>(
    () =>
      cities
        .map((slug) => {
          const c = lookupCity(slug);
          return c ? { lat: c.lat, lng: c.lng, label: c.nameZh, sub: c.nameEn } : null;
        })
        .filter((m): m is NonNullable<typeof m> => m !== null),
    [cities]
  );
  const unknown = cities.filter((s) => !lookupCity(s));

  if (markers.length < 2) {
    return (
      <div className="map-fallback">
        🗺️ 路线图:地图数据不足(需要 ≥ 2 个已知城市)。
        {unknown.length > 0 && (
          <div style={{ marginTop: 6, fontSize: 12 }}>
            未识别:<code>{unknown.join(', ')}</code>。可在 <code>@/lib/cityCoords.ts</code> 添加坐标。
          </div>
        )}
      </div>
    );
  }

  return (
    <Suspense fallback={<div className="map-fallback">🗺️ 加载路线图…</div>}>
      <MapCanvas
        markers={markers}
        connect
        numbered
        height={height}
        ariaLabel="路线图"
        footer={
          unknown.length > 0 ? (
            <span>
              ⚠️ 未识别城市:<code>{unknown.join(', ')}</code>(加坐标到 <code>cityCoords.ts</code>)
            </span>
          ) : undefined
        }
      />
    </Suspense>
  );
}
