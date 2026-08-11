import { describe, expect, test } from "bun:test";
import {
  buildOverviewModules,
  formatFeedDate,
  rssEmptyReason,
  type OverviewInput,
  type RssCollection,
} from "../src/utils/osint-summary";

/**
 * These tests exist to stop one specific regression coming back: the OSINT
 * Overview tab used to render six hardcoded cards ("24 DNS results", "3 repos
 * leak internal endpoints · 1 secret token flagged", "88 news mentions · 412
 * outlets · 14 languages") against a target nothing had looked at, and the RSS
 * handler substituted invented headlines attributed to real outlets whenever a
 * feed came back empty.
 *
 * So the assertions below are mostly about ABSENCE — that nothing appears when
 * nothing was collected, and that "not collected" never degrades into 0.
 */

const EMPTY: OverviewInput = {
  profile: null,
  cyberThreats: [],
  telegramPosts: [],
  rss: null,
};

const byKey = (input: OverviewInput) =>
  Object.fromEntries(buildOverviewModules(input).map((m) => [m.key, m]));

describe("buildOverviewModules — nothing collected", () => {
  test("reports every uncollected source as null, never 0", () => {
    const cards = byKey(EMPTY);
    for (const key of ["dns", "certificates", "github", "cyber", "rss"]) {
      expect(cards[key].count).toBeNull();
    }
  });

  test("emits no card for a capability the system does not collect", () => {
    // "Public documents" and "Search results" carried counts of 12 and 214 and
    // nothing has ever collected either. They must stay deleted, not return
    // with a zero.
    const keys = buildOverviewModules(EMPTY).map((m) => m.key);
    expect(keys).not.toContain("documents");
    expect(keys).not.toContain("search");
  });

  test("no card claims a finding about repository contents", () => {
    const github = byKey({
      ...EMPTY,
      profile: { github: [{ name: "a" }, { name: "b" }, { name: "c" }] },
    }).github;
    expect(github.count).toBe(3);
    // The old note read "3 repos leak internal endpoints · 1 secret token
    // flagged". Nothing fetches repository contents, so no AFFIRMATIVE claim
    // about what they hold is permitted. Disclaiming the capability is fine —
    // "not scanned for secrets" is the honest form and must survive.
    expect(github.note).not.toMatch(/\bleak(s|ed|ing)?\b/i);
    expect(github.note).not.toMatch(/\bflagged\b/i);
    expect(github.note).not.toMatch(/\bexposed\b/i);
    expect(github.note).toMatch(/not scanned for secrets/i);
  });

  test("carries no invented registrar, certificate or outlet figures", () => {
    const notes = buildOverviewModules(EMPTY)
      .map((m) => m.note)
      .join(" ");
    expect(notes).not.toMatch(/NameCheap|2019-08-14|CT-log matches|412 outlets|14 languages/);
  });
});

describe("buildOverviewModules — DNS and WHOIS", () => {
  test("counts resolved records, not the handler's status strings", () => {
    // fetchOSINT writes these literals when a lookup finds nothing. Counting
    // them as records is how "24 DNS results" looked plausible.
    const card = byKey({
      ...EMPTY,
      profile: {
        dns: { a: "No records found", mx: "Resolution failed" },
        whois: { Registrar: "N/A (Not a domain target)" },
      },
    }).dns;
    expect(card.count).toBe(0);
    expect(card.tone).toBe("unverified");
    expect(card.note).not.toMatch(/N\/A/);
  });

  test("counts a genuine resolution and names the registrar it was given", () => {
    const card = byKey({
      ...EMPTY,
      profile: {
        dns: { a: "104.18.0.1", mx: "No records found" },
        whois: { Registrar: "MarkMonitor Inc." },
      },
    }).dns;
    expect(card.count).toBe(1);
    expect(card.tone).toBe("verified");
    expect(card.note).toContain("MarkMonitor Inc.");
  });

  test("does not invent a registrar while the lookup is still in flight", () => {
    const card = byKey({
      ...EMPTY,
      profile: { dns: { a: "1.2.3.4" }, whois: { Registrar: "Querying registry..." } },
    }).dns;
    expect(card.note).not.toMatch(/Querying/);
    expect(card.note).toMatch(/not reported by the registry/i);
  });
});

describe("buildOverviewModules — certificate transparency", () => {
  test("a failed crt.sh lookup is 'not collected', never zero certificates", () => {
    const card = byKey({
      ...EMPTY,
      profile: { certificates: [], certificatesError: "crt.sh timed out after 25s" },
    }).certificates;
    // This is the distinction recon-sources.ts draws: a thrown error and an
    // empty array are different facts and may never be collapsed.
    expect(card.count).toBeNull();
    expect(card.note).toContain("crt.sh timed out after 25s");
  });

  test("a successful lookup returning nothing is reported as a real finding", () => {
    const card = byKey({
      ...EMPTY,
      profile: { certificates: [], certificatesError: null },
    }).certificates;
    expect(card.count).toBe(0);
    expect(card.note).toMatch(/answered; no certificates logged/i);
  });

  test("counts the hostnames actually observed", () => {
    const card = byKey({
      ...EMPTY,
      profile: {
        certificates: [{ hostname: "a.example.com" }, { hostname: "b.example.com" }],
        certificatesError: null,
      },
    }).certificates;
    expect(card.count).toBe(2);
  });
});

describe("buildOverviewModules — threat indicators", () => {
  test("states that the blocklists are not filtered to the target", () => {
    const card = byKey({ ...EMPTY, cyberThreats: [{ ip: "1.1.1.1" }, { ip: "2.2.2.2" }] }).cyber;
    expect(card.count).toBe(2);
    // The count is global blocklist size. Without this the number reads as
    // "two indicators for the domain you typed".
    expect(card.note).toMatch(/not filtered to this target/i);
  });

  test("an outage is not an empty threat landscape", () => {
    const card = byKey(EMPTY).cyber;
    expect(card.count).toBeNull();
    expect(card.note).toMatch(/not collected/i);
  });
});

describe("buildOverviewModules — RSS", () => {
  const rss: RssCollection = {
    feeds: {
      politics: [{ source: "BBC News" }, { source: "BBC News" }],
      cyber: [{ source: "Krebs on Security" }],
      military: [],
      finance: [],
      incident: [],
    },
    errors: { politics: [], cyber: [], military: ["CSIS Reports: 503"], finance: [], incident: [] },
  };

  test("totals real items and counts distinct feeds, not invented outlets", () => {
    const card = byKey({ ...EMPTY, rss }).rss;
    expect(card.count).toBe(3);
    expect(card.note).toContain("2 feed(s)");
  });

  test("surfaces how many feeds failed rather than hiding the gap", () => {
    const card = byKey({ ...EMPTY, rss }).rss;
    expect(card.note).toMatch(/1 feed\(s\) failed to parse/);
  });
});

describe("rssEmptyReason", () => {
  const rss: RssCollection = {
    feeds: { politics: [{ title: "a" }], cyber: [], military: [] },
    errors: { politics: [], cyber: ["Krebs on Security: ETIMEDOUT"], military: [] },
  };

  test("distinguishes a filter miss from an empty collection", () => {
    expect(rssEmptyReason(rss, "politics", true)).toMatch(/filter/i);
    expect(rssEmptyReason(rss, "military", false)).toMatch(/returned no items/i);
  });

  test("names the real upstream cause when collection failed", () => {
    const reason = rssEmptyReason(rss, "cyber", false);
    expect(reason).toContain("Krebs on Security: ETIMEDOUT");
    expect(reason).toMatch(/failed/i);
  });

  test("a category that failed is never described as having returned nothing", () => {
    expect(rssEmptyReason(rss, "cyber", false)).not.toMatch(/returned no items/i);
  });
});

describe("formatFeedDate", () => {
  test("an undated item reports absence, never the current time", () => {
    // The handler used to write `item.pubDate || new Date().toISOString()`,
    // stamping "now" onto undated items and then sorting by that value.
    for (const missing of [null, undefined, "", "   "]) {
      expect(formatFeedDate(missing)).toBe("no date reported");
    }
  });

  test("never renders the epoch for a null date", () => {
    expect(formatFeedDate(null)).not.toContain("1970");
  });

  test("unparseable input is labelled, not silently dropped or defaulted", () => {
    expect(formatFeedDate("last Tuesday-ish")).toBe("unparseable date");
  });

  test("a real RFC-822 feed date is rendered", () => {
    const out = formatFeedDate("Mon, 14 Jul 2026 09:12:33 GMT");
    expect(out).not.toBe("no date reported");
    expect(out).not.toBe("unparseable date");
    expect(out).toContain("2026");
  });
});
