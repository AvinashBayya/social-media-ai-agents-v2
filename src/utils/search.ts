/**
 * Shared search core.
 *
 * Routes used to each roll their own matching, which pulled in opposite
 * directions: news required the whole query as one contiguous substring (so
 * anything the upstream engine matched semantically got thrown away), while
 * OSINT expanded synonyms and OR'd them with unanchored `includes`, so "navy"
 * matched "increase" via the substring "sea".
 *
 * Everything now goes through one parser and one matcher:
 *   - "quoted text"  exact phrase, must appear contiguously
 *   - -term          exclude; a hit on this rejects the document
 *   - a OR b         either side satisfies the group
 *   - site:host      restricts to a source/domain (also passed upstream)
 *   - bare terms     all must be present (AND), matched on word boundaries
 */

export interface ParsedQuery {
  /** Bare words that must all appear. */
  terms: string[];
  /** Quoted strings that must appear contiguously. */
  phrases: string[];
  /** Terms/phrases whose presence rejects a document. */
  exclusions: string[];
  /** Alternatives — each group is satisfied by any one of its members. */
  orGroups: string[][];
  /** `site:` restrictions, lowercased and stripped of scheme. */
  sites: string[];
  /** True when the query has no matchable content. */
  isEmpty: boolean;
  /** The original input, trimmed. */
  raw: string;
}

/** Trim, collapse internal whitespace, and casefold. Used for matching and cache keys. */
export function normalizeQuery(input: string): string {
  return input.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Tokens shorter than this are ignored — they match nearly everything. */
const MIN_TERM_LENGTH = 2;

const TOKEN_PATTERN = /"([^"]*)"|(\S+)/g;

/**
 * Split a raw query string into its operator parts. Unrecognised text falls
 * through to `terms`, so a plain query still behaves the obvious way.
 */
export function parseQuery(input: string): ParsedQuery {
  const raw = (input ?? "").trim();
  const parsed: ParsedQuery = {
    terms: [],
    phrases: [],
    exclusions: [],
    orGroups: [],
    sites: [],
    isEmpty: true,
    raw,
  };
  if (!raw) return parsed;

  // Pull out quoted spans first so operators inside them stay literal.
  const tokens: { value: string; quoted: boolean }[] = [];
  for (const match of raw.matchAll(TOKEN_PATTERN)) {
    if (match[1] !== undefined) tokens.push({ value: match[1].trim(), quoted: true });
    else if (match[2]) tokens.push({ value: match[2], quoted: false });
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.value) continue;

    // `a OR b OR c` — consume the alternatives around the keyword. Either side
    // may be quoted, so `"wagner group" OR "africa corps"` groups correctly.
    const next = tokens[i + 1];
    if (next && !next.quoted && next.value.toUpperCase() === "OR") {
      const group = [stripLeadingOperator(token.value).toLowerCase()];
      let cursor = i + 1;
      while (
        tokens[cursor] &&
        !tokens[cursor].quoted &&
        tokens[cursor].value.toUpperCase() === "OR" &&
        tokens[cursor + 1]
      ) {
        group.push(stripLeadingOperator(tokens[cursor + 1].value).toLowerCase());
        cursor += 2;
      }
      const cleaned = group.filter(Boolean);
      if (cleaned.length > 1) parsed.orGroups.push(cleaned);
      else if (cleaned.length === 1) parsed.terms.push(cleaned[0]);
      i = cursor - 1;
      continue;
    }

    // A stray OR with nothing after it is just a word.
    if (!token.quoted && token.value.toUpperCase() === "OR") continue;

    if (!token.quoted && /^-\S/.test(token.value)) {
      parsed.exclusions.push(token.value.slice(1).toLowerCase());
      continue;
    }

    if (!token.quoted && /^site:/i.test(token.value)) {
      const host = token.value
        .slice(5)
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .replace(/\/.*$/, "");
      if (host) parsed.sites.push(host);
      continue;
    }

    // `+term` is accepted and ignored: bare terms are already required.
    const value = stripLeadingOperator(token.value).toLowerCase();
    if (!value) continue;

    if (token.quoted) parsed.phrases.push(value);
    else parsed.terms.push(value);
  }

  parsed.terms = parsed.terms.filter((t) => t.length >= MIN_TERM_LENGTH);
  parsed.isEmpty =
    parsed.terms.length === 0 &&
    parsed.phrases.length === 0 &&
    parsed.orGroups.length === 0 &&
    parsed.sites.length === 0;

  return parsed;
}

function stripLeadingOperator(value: string): string {
  return value.replace(/^\+/, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary containment. Plain `includes` made "increase" match "sea" and
 * "corporate" match "rate"; this requires the term to stand as its own word.
 * Terms containing spaces are treated as a phrase with the same anchoring.
 */
export function containsWord(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const escaped = escapeRegExp(needle);
  // \b fails against non-ASCII scripts, so fall back to plain containment there.
  if (!/^[\w\s.'-]+$/.test(needle)) return haystack.includes(needle);
  return new RegExp(`(?:^|[^\\w])${escaped}(?:[^\\w]|$)`, "i").test(haystack);
}

/** True when any of the words appears as a whole word. Replaces chained `includes`. */
export function containsAnyWord(haystack: string, needles: string[]): boolean {
  return needles.some((n) => containsWord(haystack, n));
}

export interface MatchContext {
  /** Weighted higher when scoring — usually the headline. */
  title?: string;
  /** Body, snippet, or any secondary text. */
  body?: string;
  /** Publisher or domain, checked against `site:`. */
  source?: string;
  /** Extra terms (e.g. synonyms) that count as a weaker match. */
  synonyms?: string[];
}

/**
 * Does this document satisfy the query?
 *
 * An empty query matches everything, so an untouched search box shows the full
 * feed rather than nothing.
 */
export function matchesQuery(ctx: MatchContext, parsed: ParsedQuery): boolean {
  if (parsed.isEmpty) return true;

  const title = (ctx.title ?? "").toLowerCase();
  const body = (ctx.body ?? "").toLowerCase();
  const source = (ctx.source ?? "").toLowerCase();
  const haystack = `${title} ${body}`;

  for (const excluded of parsed.exclusions) {
    if (containsWord(haystack, excluded) || containsWord(source, excluded)) return false;
  }

  if (parsed.sites.length > 0) {
    const inSite = parsed.sites.some((site) => source.includes(site) || haystack.includes(site));
    if (!inSite) return false;
  }

  for (const phrase of parsed.phrases) {
    if (!haystack.includes(phrase)) return false;
  }

  for (const group of parsed.orGroups) {
    if (!group.some((option) => containsWord(haystack, option))) return false;
  }

  // Bare terms are AND by default, but a synonym hit rescues an otherwise
  // missing term so domain expansions still widen recall.
  const synonyms = (ctx.synonyms ?? []).map((s) => s.toLowerCase());
  for (const term of parsed.terms) {
    if (containsWord(haystack, term)) continue;
    if (synonyms.length > 0 && containsAnyWord(haystack, synonyms)) continue;
    return false;
  }

  return true;
}

/**
 * Relevance score. Higher is better; 0 means no signal. Title hits count for
 * more than body hits, and exact phrases for more than loose terms, so results
 * can be ranked instead of shown in whatever order the feed arrived in.
 */
export function scoreMatch(ctx: MatchContext, parsed: ParsedQuery): number {
  if (parsed.isEmpty) return 0;

  const title = (ctx.title ?? "").toLowerCase();
  const body = (ctx.body ?? "").toLowerCase();
  let score = 0;

  // A phrase is weighted by how many words it pins down, so an exact
  // "tesla layoffs" always outranks the same two words found loosely.
  for (const phrase of parsed.phrases) {
    const weight = phrase.split(/\s+/).filter(Boolean).length || 1;
    if (title.includes(phrase)) score += 8 * weight;
    else if (body.includes(phrase)) score += 4 * weight;
  }

  for (const term of parsed.terms) {
    if (containsWord(title, term)) score += 6;
    else if (containsWord(body, term)) score += 3;
  }

  for (const group of parsed.orGroups) {
    if (group.some((o) => containsWord(title, o))) score += 5;
    else if (group.some((o) => containsWord(body, o))) score += 2;
  }

  for (const synonym of ctx.synonyms ?? []) {
    if (containsWord(title, synonym.toLowerCase())) score += 2;
  }

  return score;
}

/**
 * Rebuild a query string to hand to an upstream engine. Google News and GDELT
 * understand quotes, `-` and `OR` natively, so operators are forwarded rather
 * than being applied only after the fact.
 */
export function buildUpstreamQuery(parsed: ParsedQuery): string {
  if (parsed.isEmpty) return "";
  const parts: string[] = [];
  for (const phrase of parsed.phrases) parts.push(`"${phrase}"`);
  parts.push(...parsed.terms);
  for (const group of parsed.orGroups) parts.push(`(${group.join(" OR ")})`);
  for (const site of parsed.sites) parts.push(`site:${site}`);
  for (const excluded of parsed.exclusions) parts.push(`-${excluded}`);
  return parts.join(" ").trim();
}

/**
 * Rebuild a query string for engines that understand NEITHER quotes NOR
 * boolean operators — Wikipedia's plain search and Openverse, both verified
 * live to return zero results for a query like `"sourav das" + "cjp"` that
 * buildUpstreamQuery's Google-News-shaped syntax produces (or that the
 * analyst typed directly): those literal `"` and `+` characters become part
 * of the literal search string on an engine that never parses them as
 * operators. Every phrase, term and OR-group alternative is flattened to
 * bare words, in original order, with no operator syntax at all — the words
 * are what a full-text search engine can actually use; the structure around
 * them (site:, exclusions) has no equivalent on either engine and is
 * dropped rather than leaking through as literal text.
 */
export function buildPlainQuery(parsed: ParsedQuery): string {
  if (parsed.isEmpty) return "";
  const parts: string[] = [...parsed.phrases, ...parsed.terms];
  for (const group of parsed.orGroups) parts.push(...group);
  return parts.join(" ").trim();
}

/**
 * Parse once and keep the result while the string is unchanged. Matching runs
 * per row over long feeds, so this avoids re-parsing on every comparison.
 */
const parseCache = new Map<string, ParsedQuery>();
const PARSE_CACHE_LIMIT = 50;

export function parseQueryCached(input: string): ParsedQuery {
  const key = input ?? "";
  const hit = parseCache.get(key);
  if (hit) return hit;
  const parsed = parseQuery(key);
  if (parseCache.size >= PARSE_CACHE_LIMIT) {
    const oldest = parseCache.keys().next().value;
    if (oldest !== undefined) parseCache.delete(oldest);
  }
  parseCache.set(key, parsed);
  return parsed;
}
