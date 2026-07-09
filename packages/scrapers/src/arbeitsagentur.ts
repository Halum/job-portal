import { request } from 'undici';
import type { JobAdapter, RawJob } from './types.js';

const API_URL =
  'https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v6/jobs';
const API_KEY = 'jobboerse-jobsuche'; // public key documented for this endpoint

/** Human-URL query params (PRD §9) mapped to the REST API's param names. */
const PARAM_MAP: Record<string, string> = {
  wo: 'wo',
  umkreis: 'umkreis',
  arbeitszeit: 'arbeitszeit',
  angebotsart: 'angebotsart',
  sort: 'sort',
};

/** Parse the human jobsuche URL and translate its params to the REST schema. */
export function buildApiParams(humanUrl: string): URLSearchParams {
  const src = new URL(humanUrl).searchParams;
  const out = new URLSearchParams();
  for (const [human, api] of Object.entries(PARAM_MAP)) {
    const v = src.get(human);
    if (v !== null && v !== '') out.set(api, v);
  }
  return out;
}

/** One entry of the `ergebnisliste` array. Only fields we read are typed. */
interface AgenturResult {
  referenznummer?: string;
  stellenangebotsTitel?: string;
  firma?: string;
  stellenlokationen?: { adresse?: { ort?: string } }[];
  datumErsteVeroeffentlichung?: string;
  aenderungsdatum?: string;
}

export function normalizeResult(r: AgenturResult): RawJob | null {
  const refnr = r.referenznummer;
  if (!refnr) return null; // no stable id → cannot dedupe, skip
  const posted = r.datumErsteVeroeffentlichung ?? r.aenderungsdatum;
  return {
    externalId: refnr,
    title: r.stellenangebotsTitel ?? '',
    company: r.firma,
    location: r.stellenlokationen?.[0]?.adresse?.ort,
    postedAt: posted ? new Date(posted) : undefined,
    applyUrl: `https://www.arbeitsagentur.de/jobsuche/jobdetail/${encodeURIComponent(refnr)}`,
    // ponytail: list endpoint carries no free-text description; the detail
    // endpoint does. Enrichment (S1c) fetches detail if it needs body text.
    description: '',
    raw: r,
  };
}

export function normalizeResponse(body: unknown): RawJob[] {
  const list = (body as { ergebnisliste?: AgenturResult[] })?.ergebnisliste ?? [];
  return list.map(normalizeResult).filter((j): j is RawJob => j !== null);
}

export const arbeitsagenturAdapter: JobAdapter = {
  sourceType: 'arbeitsagentur',
  async fetch(url: string): Promise<RawJob[]> {
    const params = buildApiParams(url);
    const res = await request(`${API_URL}?${params.toString()}`, {
      headers: { 'X-API-Key': API_KEY },
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`arbeitsagentur API returned HTTP ${res.statusCode}`);
    }
    return normalizeResponse(await res.body.json());
  },
};
