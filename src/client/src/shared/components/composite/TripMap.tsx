import { useMemo } from 'react';
import { MapCanvas, type MapMarker } from '@/shared/components/configured';
import { lookupCity } from '@/lib/cityCoords';

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
  );
}
