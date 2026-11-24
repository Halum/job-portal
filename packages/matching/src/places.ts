import { readFileSync } from 'node:fs';

export interface Place {
  /** Normalized name; two places are "the same city" when their keys are equal. */
  key: string;
  name: string;
  lat: number;
  lon: number;
}

/** Lower case, no diacritics, only letters and digits: "Köln" and "koeln" meet in one key. */
export const normalizeName = (s: string): string =>
  s
    .toLowerCase()
    .replaceAll('ß', 'ss')
    .replaceAll('ä', 'ae')
    .replaceAll('ö', 'oe')
    .replaceAll('ü', 'ue')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]/g, '');

export interface PlaceTable {
  /** A place from a postcode or a name in free text ("96047 Bamberg", "Bamberg, Oberfranken"), or null when unknown. */
  resolve: (text: string) => Place | null;
}

/**
 * ponytail: a name that exists in several states (Neustadt) resolves to the average of all of them, and
 * a postcode shared by several villages resolves to its first listed place. Good enough for a radius
 * check of tens of kilometres; add the state when a Target needs a small radius around such a name.
 */
export function createPlaceTable(tsv: string): PlaceTable {
  const byPostcode = new Map<string, Place>();
  const byName = new Map<string, { name: string; lat: number; lon: number; n: number }>();
  for (const line of tsv.split('\n')) {
    const [postcode, name, lat, lon] = line.split('\t');
    if (postcode === undefined || name === undefined || lat === undefined || lon === undefined)
      continue;
    const point = { lat: Number(lat), lon: Number(lon) };
    const key = normalizeName(name);
    if (!byPostcode.has(postcode)) byPostcode.set(postcode, { key, name, ...point });
    const sum = byName.get(key) ?? { name, lat: 0, lon: 0, n: 0 };
    byName.set(key, {
      name: sum.name,
      lat: sum.lat + point.lat,
      lon: sum.lon + point.lon,
      n: sum.n + 1,
    });
  }
  const named = (text: string): Place | null => {
    const key = normalizeName(text);
    const hit = key === '' ? undefined : byName.get(key);
    return hit ? { key, name: hit.name, lat: hit.lat / hit.n, lon: hit.lon / hit.n } : null;
  };
  return {
    resolve(text) {
      const code = /\b(\d{5})\b/.exec(text)?.[1];
      const byCode = code === undefined ? undefined : byPostcode.get(code);
      if (byCode) return byCode;
      return (
        named(text) ??
        text
          .split(/[,;/()]|\s-\s/)
          .map(named)
          .find((p) => p !== null) ??
        null
      );
    },
  };
}

let bundled: PlaceTable | undefined;
/** The bundled GeoNames table (CC BY 4.0, see data/NOTICE.md), read once. */
export function germanPlaces(): PlaceTable {
  bundled ??= createPlaceTable(
    readFileSync(new URL('../data/de-places.tsv', import.meta.url), 'utf8'),
  );
  return bundled;
}

/** Great-circle distance in kilometres. */
export function distanceKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
