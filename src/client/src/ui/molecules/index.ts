// Molecules — configured/composed wrappers that organisms compose.
export { Carousel } from './Carousel';
export { Collapsible, revealAndScroll } from './Collapsible';
export { SnippetText } from './SnippetText';
// MapCanvas pulls in the leaflet stack — import it lazily from './MapCanvas' directly
// (see TripMap/CityMap) so it stays out of the initial bundle. Only the type is re-exported.
export type { MapMarker } from './MapCanvas';
