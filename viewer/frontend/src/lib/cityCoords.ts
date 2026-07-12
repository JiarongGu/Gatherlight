/**
 * City coordinate dictionary for trip route maps.
 * Add entries here when a new destination appears in plans/trips/*.md.
 * Keys: lowercase slug used in `<div class="trip-map" data-cities="...">`
 */
export interface CityCoord {
  lat: number;
  lng: number;
  nameZh: string;
  nameEn: string;
}

export const CITY_COORDS: Record<string, CityCoord> = {
  // Japan — Honshu
  osaka:        { lat: 34.6937, lng: 135.5023, nameZh: '大阪',   nameEn: 'Osaka' },
  kanazawa:     { lat: 36.5613, lng: 136.6562, nameZh: '金泽',   nameEn: 'Kanazawa' },
  tokyo:        { lat: 35.6762, lng: 139.6503, nameZh: '东京',   nameEn: 'Tokyo' },
  kyoto:        { lat: 35.0116, lng: 135.7681, nameZh: '京都',   nameEn: 'Kyoto' },
  nara:         { lat: 34.6851, lng: 135.8048, nameZh: '奈良',   nameEn: 'Nara' },
  uji:          { lat: 34.8842, lng: 135.7995, nameZh: '宇治',   nameEn: 'Uji' },
  // Japan — Shikoku / Setouchi
  takamatsu:    { lat: 34.3401, lng: 134.0431, nameZh: '高松',   nameEn: 'Takamatsu' },
  naoshima:     { lat: 34.4593, lng: 133.9961, nameZh: '直岛',   nameEn: 'Naoshima' },
  teshima:      { lat: 34.4956, lng: 134.0775, nameZh: '丰岛',   nameEn: 'Teshima' },
  // Japan — Okinawa
  okinawa:      { lat: 26.2125, lng: 127.6792, nameZh: '冲绳',   nameEn: 'Okinawa' },
  naha:         { lat: 26.2125, lng: 127.6792, nameZh: '那霸',   nameEn: 'Naha' },
  // Japan — TGS venue
  makuhari:     { lat: 35.6485, lng: 140.0349, nameZh: '幕张',   nameEn: 'Makuhari' },
  // Australia
  sydney:       { lat: -33.8688, lng: 151.2093, nameZh: '悉尼',  nameEn: 'Sydney' }
};

export function lookupCity(slug: string): CityCoord | undefined {
  return CITY_COORDS[slug.toLowerCase().trim()];
}
