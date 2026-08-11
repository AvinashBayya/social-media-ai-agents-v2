/**
 * OSINT page — collection summary, pure half.
 *
 * Extracted from `routes/osint.tsx` for the reason the rest of `src/utils/`
 * exists: a route file cannot be imported by `bun test` (it calls
 * `createFileRoute` and `createServerFn` at module load, which need the Start
 * runtime), so logic living there is unreachable by any test. Everything here is
 * plain data-in/data-out and is covered by `tests/osint-summary.test.ts`.
 *
 * WHAT THIS REPLACED. The Overview tab rendered six hardcoded cards against
 * whatever target the analyst had typed:
 *
 *     DNS & WHOIS · 24 results · "Registrar: NameCheap · created 2019-08-14"
 *     TLS Certificates · 6 · "Wildcard cert · CT-log matches: 42"
 *     GitHub · 18 · "3 repos leak internal endpoints · 1 secret token flagged"
 *     Public documents · 12 · "Redacted memo consistent with authentic sample"
 *     News mentions · 88 · "412 outlets · 14 languages"
 *     Search results · 214 · "SERP variance high · possible SEO manipulation"
 *
 * Nothing had looked at the target. The two most actionable lines — leaked
 * internal endpoints, a flagged secret — were invented, and each card carried a
 * verified/high/medium confidence badge above a button that did nothing.
 *
 * The rule these follow now is the one the rest of the system follows: a count
 * is the length of a collection this page actually holds, and `null` means the
 * collector did not run or failed. `null` is never rendered as 0, because "no
 * records exist" and "we did not look" are opposite findings.
 */

export type OverviewTone = "verified" | "unverified" | "high" | "medium" | "neutral";

export interface OverviewModule {
  key: string;
  name: string;
  /** null = not collected. Never 0 as a stand-in for "we did not look". */
  count: number | null;
  tone: OverviewTone;
  note: string;
  /** Tab this card summarises, so "Open records" goes somewhere real. */
  tab: string;
}

export interface RssCollection {
  feeds: Record<string, unknown[]>;
  errors: Record<string, string[]>;
}

export interface OverviewInput {
  /** Whatever `fetchOSINT` returned, or null before it has run. */
  profile: any | null;
  cyberThreats: unknown[];
  telegramPosts: unknown[];
  rss: RssCollection | null;
}

/**
 * Strings the OSINT handler writes when a lookup found nothing. They are status
 * messages, not records, and counting them as records is how "24 DNS results"
 * looked plausible in the first place.
 */
const NON_RECORD = /^(n\/a|none|unknown|no .*found|resolution failed|querying)/i;

function isRecord(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !NON_RECORD.test(value.trim());
}

export function buildOverviewModules(input: OverviewInput): OverviewModule[] {
  const { profile, cyberThreats, telegramPosts, rss } = input;

  const dnsRecords = [profile?.dns?.a, profile?.dns?.mx].filter(isRecord);
  const registrar = profile?.whois?.Registrar;
  const registrarKnown = isRecord(registrar);

  const certError: string | null = profile?.certificatesError ?? null;
  const certs: unknown[] | null = Array.isArray(profile?.certificates)
    ? profile.certificates
    : null;
  const github: unknown[] | null = Array.isArray(profile?.github) ? profile.github : null;

  const rssItems = rss ? Object.values(rss.feeds).flat() : [];
  const rssTotal = rss ? rssItems.length : null;
  const rssOutlets = new Set(
    rssItems.map((item: any) => item?.source).filter((s: unknown) => typeof s === "string" && s),
  ).size;
  const rssFailures = rss ? Object.values(rss.errors).flat().length : 0;

  return [
    {
      key: "dns",
      name: "DNS & WHOIS",
      count: profile ? dnsRecords.length : null,
      tone: profile && dnsRecords.length > 0 ? "verified" : "unverified",
      note: !profile
        ? "Not collected."
        : registrarKnown
          ? `Registrar: ${registrar}. ${dnsRecords.length} record(s) resolved via Cloudflare DoH.`
          : `${dnsRecords.length} record(s) resolved via Cloudflare DoH. Registrar not reported by the registry.`,
      tab: "whois",
    },
    {
      key: "certificates",
      name: "TLS certificates (CT logs)",
      // A failed crt.sh lookup is "not collected", never "zero certificates".
      count: certError ? null : (certs?.length ?? null),
      tone: certError ? "unverified" : certs && certs.length > 0 ? "verified" : "neutral",
      note: certError
        ? `crt.sh lookup failed — ${certError}`
        : certs === null
          ? "Not collected."
          : certs.length === 0
            ? "crt.sh answered; no certificates logged for this domain."
            : `${certs.length} hostname(s) observed in public Certificate Transparency logs.`,
      tab: "whois",
    },
    {
      key: "github",
      name: "GitHub",
      count: github?.length ?? null,
      tone: github && github.length > 0 ? "verified" : "neutral",
      note:
        github === null
          ? "Not collected."
          : github.length === 0
            ? "GitHub code search returned no repositories for this target."
            : // Deliberately NOT "N repos leak internal endpoints". Repository
              // contents are never fetched, so any claim about what they contain
              // would be invented.
              `${github.length} public repositor${github.length === 1 ? "y" : "ies"} matched. Contents are not scanned for secrets.`,
      tab: "whois",
    },
    {
      key: "cyber",
      name: "Threat indicators",
      count: cyberThreats.length > 0 ? cyberThreats.length : null,
      tone: cyberThreats.length > 0 ? "high" : "unverified",
      note:
        cyberThreats.length > 0
          ? // The feeds are global blocklists. Saying so stops the count reading
            // as "this many indicators for your target".
            `${cyberThreats.length} indicator(s) from Feodo Tracker and C2IntelFeeds. Not filtered to this target.`
          : "Not collected — both threat feeds failed or have not run.",
      tab: "cyber",
    },
    {
      key: "telegram",
      name: "Telegram posts",
      count: telegramPosts.length,
      tone: telegramPosts.length > 0 ? "verified" : "neutral",
      note:
        telegramPosts.length > 0
          ? `${telegramPosts.length} post(s) from public channel previews.`
          : "Public channel previews returned no posts.",
      tab: "telegram",
    },
    {
      key: "rss",
      name: "News items",
      count: rssTotal,
      tone: rssTotal === null ? "unverified" : rssTotal > 0 ? "verified" : "neutral",
      note:
        rssTotal === null
          ? "Not collected."
          : `${rssTotal} item(s) from ${rssOutlets} feed(s)` +
            (rssFailures > 0 ? ` · ${rssFailures} feed(s) failed to parse.` : "."),
      tab: "rss",
    },
  ];
}

/**
 * Why an RSS category is showing nothing.
 *
 * "The feeds failed", "the feeds returned nothing" and "your filter excluded
 * everything" are three different facts and an analyst acts differently on each,
 * so they are never collapsed into one generic empty state. This is the same
 * distinction `recon-sources.ts` draws between a thrown error and an empty
 * array, applied at the render layer.
 */
export function rssEmptyReason(
  rss: RssCollection | null,
  category: string,
  filterActive: boolean,
): string {
  const collected = rss?.feeds?.[category] ?? [];
  const failures = rss?.errors?.[category] ?? [];
  if (collected.length > 0) {
    return filterActive
      ? "No item matches the current filter."
      : "No item to display for this category.";
  }
  if (failures.length > 0) return `Collection failed — ${failures.join("; ")}`;
  if (!rss) return "Not collected.";
  return "Collection succeeded; these feeds returned no items.";
}

/**
 * Publication time as the feed reported it, or an explicit absence.
 *
 * Feed items carry `pubDate: null` when the outlet published no date — the
 * handler used to substitute `new Date().toISOString()`, which stamped "now"
 * onto undated items and then sorted and displayed that value as though the
 * outlet had reported it. This must never re-introduce a default: `new
 * Date(null)` is the epoch and `new Date(undefined)` is "Invalid Date", and
 * both read to an analyst as a measurement.
 */
export function formatFeedDate(pubDate: unknown): string {
  if (typeof pubDate !== "string" || !pubDate.trim()) return "no date reported";
  const d = new Date(pubDate);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : "unparseable date";
}
