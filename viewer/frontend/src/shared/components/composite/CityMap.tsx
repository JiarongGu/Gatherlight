import { useMemo } from 'react';
import { MapCanvas, type MapMarker } from '@/shared/components/configured';

interface Props {
  pointsRaw: string;
  height?: number;
  connect?: boolean;
  title?: string;
}

/** Parse "lat,lng|label" lines (newline/semicolon separated) into markers. */
function parsePoints(raw: string): MapMarker[] {
  return raw
    .split(/[\n;]/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('|').map((s) => s.trim());
      if (parts.length < 2) return null;
      const coords = parts[0]?.split(',').map((s) => Number(s.trim()));
      if (!coords || coords.length < 2) return null;
      const [lat, lng] = coords;
      if (lat === undefined || lng === undefined || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return { lat, lng, label: parts.slice(1).join(' | ') };
    })
    .filter((p): p is MapMarker => p !== null);
}

/** L2 — points within a city, on the shared L3 MapCanvas. */
export function CityMap({ pointsRaw, height = 340, connect = false, title }: Props) {
  const markers = useMemo(() => parsePoints(pointsRaw), [pointsRaw]);

  if (markers.length < 1) {
    return <div className="map-fallback">🗺️ 城市地图:无效数据(需要至少 1 个 `lat,lng|label` 点)。</div>;
  }

  return <MapCanvas markers={markers} connect={connect} numbered height={height} footer={title} ariaLabel="城市地图" />;
}
