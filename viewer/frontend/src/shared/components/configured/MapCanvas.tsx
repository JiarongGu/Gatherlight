import { useEffect, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Polyline, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet-arrowheads';

export interface MapMarker {
  lat: number;
  lng: number;
  label: string; // primary label (tooltip + card)
  sub?: string; // secondary (e.g. English name)
}

interface Props {
  markers: MapMarker[];
  connect?: boolean; // draw an ordered arrow polyline through the markers
  numbered?: boolean; // numbered route pins (1,2,3…) vs simple dots
  height?: number;
  footer?: React.ReactNode; // caption / warning under the map
  ariaLabel?: string;
}

const ACCENT = '#3b6fe0';

// Colored basemap (CARTO Voyager) — reads better than a flat/dark map and works
// in both themes.
const TILE = {
  url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
  attribution: '&copy; OpenStreetMap &copy; CARTO'
};

function pinIcon(n: number, numbered: boolean, active: boolean): L.DivIcon {
  return L.divIcon({
    className: 'map-pin',
    html: numbered
      ? `<span class="map-pin-num ${active ? 'active' : ''}">${n}</span>`
      : `<span class="map-pin-dot ${active ? 'active' : ''}"></span>`,
    iconSize: numbered ? [26, 26] : [14, 14],
    iconAnchor: numbered ? [13, 13] : [7, 7],
    tooltipAnchor: [0, numbered ? -16 : -10]
  });
}

function ArrowLine({ positions }: { positions: [number, number][] }) {
  const ref = useRef<L.Polyline | null>(null);
  useEffect(() => {
    const line = ref.current;
    if (!line || positions.length < 2) return;
    (line as L.Polyline & { arrowheads?: (o: Record<string, unknown>) => L.Polyline }).arrowheads?.({
      size: '12px',
      frequency: 'allvertices',
      fill: true,
      yawn: 50,
      color: ACCENT
    });
    return () => (line as L.Polyline & { deleteArrowheads?: () => void }).deleteArrowheads?.();
  }, [positions]);
  return (
    <Polyline
      ref={(r) => {
        ref.current = r as L.Polyline | null;
      }}
      positions={positions}
      pathOptions={{ color: ACCENT, weight: 4, opacity: 0.85 }}
    />
  );
}

/** Imperative: fit bounds + resize + scroll-zoom only when expanded. */
function MapController({ positions, expanded }: { positions: [number, number][]; expanded: boolean }) {
  const map = useMap();
  useEffect(() => {
    if (positions.length >= 2) map.fitBounds(L.latLngBounds(positions), { padding: [40, 40] });
    else if (positions.length === 1) map.setView(positions[0], 14);
  }, [map, positions]);
  useEffect(() => {
    if (expanded) map.scrollWheelZoom.enable();
    else map.scrollWheelZoom.disable();
    const t = setTimeout(() => map.invalidateSize(), 60);
    return () => clearTimeout(t);
  }, [map, expanded]);
  return null;
}

/**
 * L3 — the shared, advanced map: colored tiles, numbered route pins, ordered
 * arrow line, fullscreen (scroll-zoom for detail), and a detail card on pin click.
 */
export function MapCanvas({ markers, connect, numbered = true, height = 380, footer, ariaLabel }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const positions = markers.map((m) => [m.lat, m.lng] as [number, number]);

  useEffect(() => {
    if (!expanded) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && setExpanded(false);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [expanded]);

  const sel = selected != null ? markers[selected] : null;

  return (
    <div className={`map-canvas no-print ${expanded ? 'map-expanded' : ''}`} style={expanded ? undefined : { height }}>
      <button
        type="button"
        className="map-expand-btn"
        title={expanded ? '退出全屏 (Esc)' : '放大查看 / 滚轮缩放'}
        onClick={() => setExpanded((e) => !e)}
      >
        {expanded ? '✕' : '⛶'}
      </button>
      <MapContainer style={{ height: '100%', width: '100%' }} scrollWheelZoom={false} zoomControl attributionControl>
        <TileLayer attribution={TILE.attribution} url={TILE.url} />
        <MapController positions={positions} expanded={expanded} />
        {connect && positions.length >= 2 && <ArrowLine positions={positions} />}
        {markers.map((m, i) => (
          <Marker
            key={i}
            position={[m.lat, m.lng]}
            icon={pinIcon(i + 1, numbered, i === selected)}
            eventHandlers={{ click: () => setSelected(i) }}
          >
            <Tooltip permanent direction="top" className="map-tip" aria-label={ariaLabel}>
              <strong>{i + 1}.</strong> {m.label}
              {m.sub && <span className="map-tip-sub"> {m.sub}</span>}
            </Tooltip>
          </Marker>
        ))}
      </MapContainer>

      {sel && (
        <div className="map-detail-card">
          <button type="button" className="map-detail-close" aria-label="关闭" onClick={() => setSelected(null)}>
            ✕
          </button>
          <div className="map-detail-num">{selected! + 1}</div>
          <div className="map-detail-body">
            <div className="map-detail-title">{sel.label}</div>
            {sel.sub && <div className="map-detail-sub">{sel.sub}</div>}
            <div className="map-detail-coord">
              {sel.lat.toFixed(4)}, {sel.lng.toFixed(4)}
            </div>
            <a
              className="map-detail-link"
              href={`https://www.google.com/maps/search/?api=1&query=${sel.lat},${sel.lng}`}
              target="_blank"
              rel="noreferrer"
            >
              在 Google 地图打开 ↗
            </a>
          </div>
        </div>
      )}

      {footer && <div className="map-footer">{footer}</div>}
    </div>
  );
}
