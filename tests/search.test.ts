import { describe, expect, test } from "bun:test";
import { buildPlainQuery, buildUpstreamQuery, parseQuery } from "../src/utils/search";

describe("buildPlainQuery", () => {
  // The exact query reported live on /images: Wikipedia and Openverse both
  // returned zero results, because buildUpstreamQuery's (or the analyst's
  // own) Google-style syntax was being sent verbatim to engines that don't
  // parse quotes or `+` as operators — those characters just become part of
  // the literal search string.
  test("flattens two quoted phrases joined by a bare + into plain words", () => {
    const parsed = parseQuery('"sourav das" + "cjp"');
    expect(buildPlainQuery(parsed)).toBe("sourav das cjp");
  });

  test("drops OR-group structure, keeping every alternative as a bare word", () => {
    const parsed = parseQuery('"wagner group" OR "africa corps"');
    expect(buildPlainQuery(parsed)).toBe("wagner group africa corps");
  });

  test("drops site: and exclusion operators entirely — no equivalent on a plain search engine", () => {
    const parsed = parseQuery("sourav das site:reddit.com -spam");
    expect(buildPlainQuery(parsed)).toBe("sourav das");
  });

  test("a plain unquoted query passes through unchanged", () => {
    const parsed = parseQuery("sourav das");
    expect(buildPlainQuery(parsed)).toBe("sourav das");
  });

  test("an empty query returns an empty string, not a fabricated fallback", () => {
    expect(buildPlainQuery(parseQuery(""))).toBe("");
    expect(buildPlainQuery(parseQuery("   "))).toBe("");
  });

  test("a query with only a site: restriction is empty — no bare words to flatten", () => {
    const parsed = parseQuery("site:reddit.com");
    expect(buildPlainQuery(parsed)).toBe("");
  });
});

describe("buildUpstreamQuery vs buildPlainQuery — same input, different shape", () => {
  test("buildUpstreamQuery keeps quotes; buildPlainQuery does not", () => {
    const parsed = parseQuery('"sourav das" + "cjp"');
    expect(buildUpstreamQuery(parsed)).toBe('"sourav das" "cjp"');
    expect(buildPlainQuery(parsed)).toBe("sourav das cjp");
  });
});
