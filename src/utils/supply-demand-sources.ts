/**
 * Module 5 — Kpler Supply & Demand collector.
 *
 * A separate file from geo-sources.ts on purpose: every other GIS collector
 * is auto-triggered from the page's free-text target search
 * (`collectGeoLayers(query)`), but Kpler's API takes explicit product and
 * zone parameters — there is no keyword query that maps onto "Corn balance
 * for Argentina and Brazil". The analyst picks domain/product/zones/period
 * on the GIS page and this is called directly, not folded into
 * `collectGeoLayers`'s Promise.all.
 *
 * Kpler is a COMMERCIAL data provider (api.kpler.com) with no free tier —
 * unlike every other source in geo-sources.ts, a working KPLER_API_KEY is a
 * real budget line, not a free registration. Per docs/OpenApiSpec-Supply &
 * Demand-v2.json, auth is `Authorization: Basic <api-key>` (Kpler's own
 * literal key format, not standard HTTP Basic user:pass encoding).
 */

import { createServerFn } from "@tanstack/react-start";
import { recordCredentialUse, resolveCredential } from "./credential-vault";
import { fromKplerBalance, type GeoRecord, type LayerResult } from "./geo";

const KPLER_BASE = "https://api.kpler.com/v2";
const TIMEOUT_MS = 15_000;

export type GrainsProduct = "Corn" | "Soybean" | "Wheat";
export type SupplyDemandDomain = "grains" | "lng" | "gas";

export interface SupplyDemandParams {
  domain: SupplyDemandDomain;
  /** Required when domain is "grains"; ignored otherwise. */
  product?: GrainsProduct;
  zones: string[];
  /** Grains only. */
  minYear?: number;
  maxYear?: number;
  /** LNG/gas only, YYYY-MM-DD. */
  startDate?: string;
  endDate?: string;
}

async function kplerGet(path: string, params: Record<string, unknown>, apiKey: string): Promise<any> {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) qs.append(key, String(item));
    } else {
      qs.set(key, String(value));
    }
  }
  const res = await fetch(`${KPLER_BASE}${path}?${qs.toString()}`, {
    headers: { authorization: `Basic ${apiKey}`, accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Kpler HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Fetch balance-sheet data and turn it into GeoRecords. Never throws —
 * mirrors every other collector in geo-sources.ts: a missing credential or
 * upstream failure comes back as `LayerResult.error`, with zero records,
 * never a fabricated balance.
 */
export async function collectSupplyDemand(params: SupplyDemandParams): Promise<LayerResult> {
  const resolved = await resolveCredential("kpler");
  const apiKey = resolved?.secret;
  if (!apiKey) {
    return {
      layer: "supplyDemand",
      records: [],
      unplaceable: 0,
      error:
        "Kpler Supply & Demand requires a paid API key — Kpler is a commercial " +
        "commodity-intelligence provider with no free tier. Set KPLER_API_KEY, or add a " +
        "Kpler credential on the Settings page, to enable this layer. No balances are shown " +
        "— which is a missing credential, not a finding of zero supply or demand.",
    };
  }
  if (params.zones.length === 0) {
    return {
      layer: "supplyDemand",
      records: [],
      unplaceable: 0,
      error: "At least one zone/country is required.",
    };
  }
  if (params.domain === "grains" && !params.product) {
    return {
      layer: "supplyDemand",
      records: [],
      unplaceable: 0,
      error: "A grains product (Corn, Soybean or Wheat) is required.",
    };
  }

  try {
    let raw: any;
    let product: string;
    if (params.domain === "grains") {
      product = params.product!;
      raw = await kplerGet(
        "/supply-demand/grains/balances",
        { product, zones: params.zones, minYear: params.minYear, maxYear: params.maxYear },
        apiKey,
      );
    } else if (params.domain === "lng") {
      product = "LNG";
      raw = await kplerGet(
        "/supply-demand/lng/balances",
        { zones: params.zones, startDate: params.startDate, endDate: params.endDate },
        apiKey,
      );
    } else {
      product = "Gas";
      raw = await kplerGet(
        "/supply-demand/gas/balances",
        { zones: params.zones, startDate: params.startDate, endDate: params.endDate },
        apiKey,
      );
    }
    await recordCredentialUse("kpler", resolved.entryId);

    const units: Record<string, string> = raw?.metadata?.units ?? {};
    const rows: any[] = raw?.data ?? [];
    const records: GeoRecord[] = [];
    let unplaceable = 0;
    for (const row of rows) {
      const record = fromKplerBalance({
        domain: params.domain,
        product,
        zone: String(row?.zone ?? ""),
        startDate: String(row?.startDate ?? ""),
        endDate: String(row?.endDate ?? ""),
        metrics: row?.metrics ?? {},
        units,
      });
      if (record) records.push(record);
      else unplaceable += 1;
    }
    return { layer: "supplyDemand", records, unplaceable, error: null };
  } catch (err: any) {
    return {
      layer: "supplyDemand",
      records: [],
      unplaceable: 0,
      error: `Kpler unavailable: ${err?.message ?? String(err)}`,
    };
  }
}

export const fetchSupplyDemand = createServerFn({ method: "POST" })
  .validator((d: SupplyDemandParams) => d)
  .handler(async ({ data }) => collectSupplyDemand(data));
