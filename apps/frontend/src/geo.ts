// Geocoding + distance helpers for same-day delivery quotes.
// Uses free services: OpenStreetMap Nominatim (geocoding) and OSRM (driving distance).

import type { LatLng, SamedayConfig } from './types';

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

// Nominatim rate limit is 1 request/second — wait between fallback attempts
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

async function nominatim(params: Record<string, string>): Promise<LatLng | null> {
  const qs = new URLSearchParams({ format: 'json', limit: '1', countrycodes: 'my', ...params });
  const res = await fetch(`${NOMINATIM}?${qs}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.length) return null;
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
}

// Free-form address → { lat, lng } | null (used for the store's own address).
// Nominatim often fails on full Malaysian street addresses (unit/lot numbers),
// so fall back progressively: full address → without first segment → postcode only.
export async function geocodeAddress(query: string): Promise<LatLng | null> {
  if (!query?.trim()) return null;
  try {
    const full = await nominatim({ q: query });
    if (full) return full;

    const parts = query.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length > 2) {
      await pause(1100);
      const withoutUnit = await nominatim({ q: parts.slice(1).join(', ') });
      if (withoutUnit) return withoutUnit;
    }

    const pc = query.match(/\b\d{5}\b/);
    if (pc) {
      await pause(1100);
      const byPostcode = await nominatim({ postalcode: pc[0] });
      if (byPostcode) return byPostcode;
      await pause(1100);
      return await nominatim({ q: `${pc[0]} Malaysia` });
    }
    return null;
  } catch { return null; }
}

// Postcode → { lat, lng } | null. Postcode centroid is accurate enough for a fee quote.
export async function geocodePostcode(postcode: string): Promise<LatLng | null> {
  if (!/^\d{5}$/.test(postcode)) return null;
  try {
    const byPostcode = await nominatim({ postalcode: postcode });
    if (byPostcode) return byPostcode;
    await pause(1100);
    return await nominatim({ q: `${postcode} Malaysia` });
  } catch { return null; }
}

export function haversineKm(a: LatLng, b: LatLng) {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

// Driving distance in km via OSRM; falls back to haversine × 1.4 (road factor)
export async function drivingKm(from: LatLng, to: LatLng) {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (data.routes?.[0]?.distance != null) return data.routes[0].distance / 1000;
    }
  } catch { /* fall through */ }
  return haversineKm(from, to) * 1.4;
}

// Fee = base + perKm × km, rounded UP to nearest RM 0.50
export function samedayFee(km: number, cfg: SamedayConfig) {
  const raw = (Number(cfg.base) || 0) + (Number(cfg.perKm) || 0) * km;
  return Math.ceil(raw * 2) / 2;
}

// Full quote: customer postcode → { km, fee } | { error: 'geocode' | 'range' }
export async function quoteSameday(postcode: string, sameday: SamedayConfig) {
  if (!sameday?.originLat || !sameday?.originLng) return { error: 'geocode' };
  const dest = await geocodePostcode(postcode);
  if (!dest) return { error: 'geocode' };
  const km = await drivingKm({ lat: sameday.originLat, lng: sameday.originLng }, dest);
  const kmRounded = Math.round(km * 10) / 10;
  if (sameday.maxKm && kmRounded > sameday.maxKm) return { error: 'range', km: kmRounded };
  return { km: kmRounded, fee: samedayFee(kmRounded, sameday) };
}
