import { describe, expect, test } from "bun:test";
import {
  cellSizeForZoom,
  clusterByGrid,
  filterByTime,
  fromExifImage,
  fromGdeltArticle,
  fromUcdpEvent,
  fromUsgsFeature,
  isRealCoordinate,
  summarise,
  timeExtent,
  COUNTRY_CENTROIDS,
  GEO_LAYERS,
  PRECISION_RADIUS_M,
  type GeoRecord,
  type LayerResult,
} from "../src/utils/geo";

// ─── Fixtures: shaped exactly like the live APIs return ────────────────────

const USGS_FEATURE = {
  id: "us7000abcd",
  geometry: { coordinates: [-66.9105, 17.966, 12.5] },
  properties: {
    mag: 2.9,
    place: "0 km SSW of Guanica, Puerto Rico",
    time: 1785802675050,
    title: "M 2.9 - 0 km SSW of Guanica, Puerto Rico",
    url: "https://earthquake.usgs.gov/earthquakes/eventpage/us7000abcd",
    felt: 3,
  },
};

const UCDP_EVENT = {
  id: 512345,
  country: "Ukraine",
  region: "Europe",
  latitude: 48.9226,
  longitude: 37.8019,
  date_start: "2026-07-14",
  where_prec: 1,
  type_of_violence: 1,
  side_a: "Government of Ukraine",
  side_b: "Russia",
  deaths_a: 3,
  deaths_b: 5,
  deaths_civilians: 2,
};

// Verified against the live API: a Sputnik article about India carries
// sourcecountry "China". The outlet is not the event.
const GDELT_ARTICLE = {
  url: "https://sputniknews.cn/20260727/1072500390.html",
  title: "Report on Indian maritime incident",
  seendate: "20260727T144500Z",
  domain: "sputniknews.cn",
  language: "Chinese",
  sourcecountry: "China",
};

const EXIF_IMAGE = {
  id: "img-1",
  name: "checkpoint.jpg",
  gps: { latitude: 28.6139, longitude: 77.209, altitude: 216 },
  capturedAt: "2026-07-14T09:12:33.000Z",
  camera: "Canon EOS R5",
};

// ─── The central guarantee ─────────────────────────────────────────────────

describe("no coordinate is ever synthesised", () => {
  test("every adapter returns null rather than a placed marker when the coordinate is missing", () => {
    // This is the whole point of the module. The previous implementation put
    // news at a country centroid plus +/-2.25 degrees of Math.random() jitter,
    // cyber threats at a hardcoded 45.0N/15.0E, and Telegram at 48.0N/31.0E —
    // roughly 250 km of fabricated displacement, rendered as geolocation.
    expect(fromUsgsFeature({ geometry: {}, properties: { time: 1 } })).toBeNull();
    expect(fromUsgsFeature({ geometry: { coordinates: [null, null] }, properties: {} })).toBeNull();
    expect(fromUcdpEvent({ ...UCDP_EVENT, latitude: null, longitude: null })).toBeNull();
    expect(fromUcdpEvent({ ...UCDP_EVENT, latitude: undefined, longitude: undefined })).toBeNull();
    expect(fromGdeltArticle({ ...GDELT_ARTICLE, sourcecountry: "" })).toBeNull();
    expect(fromExifImage({ ...EXIF_IMAGE, gps: null })).toBeNull();
  });

  test("every produced marker traces back to a real coordinate on its source record", () => {
    const cases: { record: GeoRecord | null; lat: number; lon: number }[] = [
      { record: fromUsgsFeature(USGS_FEATURE), lat: 17.966, lon: -66.9105 },
      { record: fromUcdpEvent(UCDP_EVENT), lat: 48.9226, lon: 37.8019 },
      { record: fromExifImage(EXIF_IMAGE), lat: 28.6139, lon: 77.209 },
    ];
    for (const c of cases) {
      expect(c.record).not.toBeNull();
      // Exactly the source value — no jitter, no offset, no rounding drift.
      expect(c.record!.lat).toBe(c.lat);
      expect(c.record!.lon).toBe(c.lon);
    }
  });

  test("a GDELT marker sits exactly on the published centroid, never offset", () => {
    const r = fromGdeltArticle(GDELT_ARTICLE)!;
    expect([r.lat, r.lon]).toEqual(COUNTRY_CENTROIDS["China"]);
  });

  test("0,0 is rejected as a missing-value sentinel, not plotted in the Gulf of Guinea", () => {
    expect(isRealCoordinate(0, 0)).toBe(false);
    expect(fromUcdpEvent({ ...UCDP_EVENT, latitude: 0, longitude: 0 })).toBeNull();
  });

  test("out-of-range and non-numeric coordinates are rejected", () => {
    expect(isRealCoordinate(91, 0)).toBe(false);
    expect(isRealCoordinate(0, 181)).toBe(false);
    expect(isRealCoordinate(NaN, 10)).toBe(false);
    expect(isRealCoordinate(Infinity, 10)).toBe(false);
    expect(isRealCoordinate("48.9" as any, 37.8)).toBe(false);
  });

  test("a record without a usable timestamp is rejected — the time slider must not lie either", () => {
    expect(
      fromUsgsFeature({ ...USGS_FEATURE, properties: { ...USGS_FEATURE.properties, time: null } }),
    ).toBeNull();
    expect(
      fromUcdpEvent({ ...UCDP_EVENT, date_start: "not-a-date", date_end: undefined }),
    ).toBeNull();
    expect(fromExifImage({ ...EXIF_IMAGE, capturedAt: null })).toBeNull();
  });
});

// ─── Precision honesty ─────────────────────────────────────────────────────

describe("coordinate precision is represented honestly", () => {
  test("USGS epicentres and EXIF fixes are exact", () => {
    expect(fromUsgsFeature(USGS_FEATURE)!.precision).toBe("exact");
    expect(fromExifImage(EXIF_IMAGE)!.precision).toBe("exact");
  });

  test("GDELT is country precision and says it locates the OUTLET, not the event", () => {
    // The trap this guards against: plotting a Chinese outlet's report about
    // India as an event in China.
    const r = fromGdeltArticle(GDELT_ARTICLE)!;
    expect(r.precision).toBe("country");
    expect(r.locates).toContain("PUBLISHING OUTLET");
    expect(r.locates).toContain("NOT the location of the event");
  });

  test("UCDP's own where_prec code drives precision rather than an assumption", () => {
    expect(fromUcdpEvent({ ...UCDP_EVENT, where_prec: 1 })!.precision).toBe("exact");
    expect(fromUcdpEvent({ ...UCDP_EVENT, where_prec: 2 })!.precision).toBe("exact");
    expect(fromUcdpEvent({ ...UCDP_EVENT, where_prec: 3 })!.precision).toBe("city");
    expect(fromUcdpEvent({ ...UCDP_EVENT, where_prec: 5 })!.precision).toBe("country");
  });

  test("imprecise classes carry a non-zero uncertainty radius; exact renders as a point", () => {
    expect(PRECISION_RADIUS_M.exact).toBe(0);
    expect(PRECISION_RADIUS_M.city).toBeGreaterThan(0);
    expect(PRECISION_RADIUS_M.country).toBeGreaterThan(PRECISION_RADIUS_M.city);
  });

  test("every record states in words what its coordinate locates", () => {
    for (const r of [
      fromUsgsFeature(USGS_FEATURE)!,
      fromUcdpEvent(UCDP_EVENT)!,
      fromGdeltArticle(GDELT_ARTICLE)!,
      fromExifImage(EXIF_IMAGE)!,
    ]) {
      expect(r.locates.length).toBeGreaterThan(15);
    }
  });
});

// ─── Magnitude ─────────────────────────────────────────────────────────────

describe("magnitude", () => {
  test("UCDP fatalities are summed across all recorded categories", () => {
    expect(fromUcdpEvent(UCDP_EVENT)!.magnitude).toBe(10);
  });

  test("news and imagery report no magnitude rather than a placeholder zero", () => {
    expect(fromGdeltArticle(GDELT_ARTICLE)!.magnitude).toBeNull();
    expect(fromExifImage(EXIF_IMAGE)!.magnitude).toBeNull();
  });

  test("a seismic event without a reported magnitude says so", () => {
    const r = fromUsgsFeature({
      ...USGS_FEATURE,
      properties: { ...USGS_FEATURE.properties, mag: null },
    })!;
    expect(r.magnitude).toBeNull();
    expect(r.magnitudeLabel).toContain("not reported");
  });
});

// ─── Clustering ────────────────────────────────────────────────────────────

describe("clustering", () => {
  const records = [
    fromUsgsFeature(USGS_FEATURE)!,
    fromUsgsFeature({ ...USGS_FEATURE, id: "b", geometry: { coordinates: [-66.92, 17.97, 10] } })!,
    fromUcdpEvent(UCDP_EVENT)!,
  ];

  test("groups nearby records and leaves distant ones apart", () => {
    const clusters = clusterByGrid(records, 1);
    expect(clusters.length).toBe(2);
    const big = clusters.find((c) => c.members.length === 2)!;
    expect(big.members.every((m) => m.layer === "seismic")).toBe(true);
  });

  test("a cluster is only as precise as its WORST member", () => {
    // Averaging an exact fix with a country centroid and calling the result
    // exact would manufacture precision out of aggregation.
    // Both in the positive-lon hemisphere: the grid splits at the prime
    // meridian, so a cross-meridian pair would land in different cells however
    // large the cell is.
    const mixed = [fromUcdpEvent(UCDP_EVENT)!, fromGdeltArticle(GDELT_ARTICLE)!];
    const [cluster] = clusterByGrid(mixed, 180);
    expect(cluster.members.length).toBe(2);
    expect(cluster.precision).toBe("country");
  });

  test("cell size coarsens as zoom decreases", () => {
    expect(cellSizeForZoom(12)).toBeLessThan(cellSizeForZoom(6));
    expect(cellSizeForZoom(6)).toBeLessThan(cellSizeForZoom(2));
  });

  test("rejects a non-positive cell size instead of looping forever", () => {
    expect(() => clusterByGrid(records, 0)).toThrow();
  });

  test("clustering preserves every record — nothing is dropped", () => {
    const total = clusterByGrid(records, 2).reduce((s, c) => s + c.members.length, 0);
    expect(total).toBe(records.length);
  });
});

// ─── Time filtering ────────────────────────────────────────────────────────

describe("time filtering", () => {
  const records = [
    { ...fromUsgsFeature(USGS_FEATURE)!, timestamp: "2026-07-01T00:00:00.000Z" },
    { ...fromUcdpEvent(UCDP_EVENT)!, timestamp: "2026-07-15T00:00:00.000Z" },
    { ...fromExifImage(EXIF_IMAGE)!, timestamp: "2026-07-30T00:00:00.000Z" },
  ];

  test("reports the real extent of the data", () => {
    const ex = timeExtent(records)!;
    expect(new Date(ex.fromMs).toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(new Date(ex.toMs).toISOString()).toBe("2026-07-30T00:00:00.000Z");
  });

  test("filters inclusively on both ends", () => {
    const from = Date.parse("2026-07-10T00:00:00.000Z");
    const to = Date.parse("2026-07-30T00:00:00.000Z");
    expect(filterByTime(records, from, to).length).toBe(2);
  });

  test("an undated set has no extent rather than a fabricated one", () => {
    expect(timeExtent([])).toBeNull();
    expect(timeExtent([{ ...records[0], timestamp: "nonsense" }])).toBeNull();
  });
});

// ─── Layer reporting ───────────────────────────────────────────────────────

describe("layer summary", () => {
  const results: LayerResult[] = [
    { layer: "seismic", records: [fromUsgsFeature(USGS_FEATURE)!], unplaceable: 0, error: null },
    { layer: "news", records: [], unplaceable: 12, error: null },
    { layer: "conflict", records: [], unplaceable: 0, error: "UCDP requires an API token" },
  ];

  test("counts what was excluded and says why it was excluded rather than approximated", () => {
    const s = summarise(results);
    expect(s.plotted).toBe(1);
    expect(s.unplaceable).toBe(12);
    expect(s.note).toContain("EXCLUDED rather than approximated");
  });

  test("a failed layer is reported as a failure, not as zero findings", () => {
    // "UCDP needs a token" and "there are no conflicts anywhere" are opposite
    // claims and must not render identically.
    const s = summarise(results);
    expect(s.note).toContain("could not be collected");
    expect(s.byLayer.find((l) => l.layer === "conflict")!.error).toContain("token");
  });

  test("every declared layer documents where its coordinates come from", () => {
    for (const layer of GEO_LAYERS) {
      expect(layer.provenance.length).toBeGreaterThan(40);
    }
  });

  test("the unwired infrastructure layer says so instead of being quietly absent", () => {
    const infra = GEO_LAYERS.find((l) => l.id === "infrastructure")!;
    expect(infra.provenance).toContain("returns no geolocation");
    expect(infra.provenance).toContain("No coordinates are invented");
  });
});
