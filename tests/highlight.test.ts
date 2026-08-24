import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { highlightMatches } from "../src/utils/highlight";

function render(text: string, query: string | null | undefined): string {
  return renderToStaticMarkup(highlightMatches(text, query) as any);
}

describe("highlightMatches", () => {
  test("wraps a single case-insensitive match in <mark>", () => {
    const html = render("Chef Ankit Bhatt of Fairfield", "ankit bhatt");
    expect(html).toContain("<mark");
    expect(html).toContain(">Ankit Bhatt</mark>");
  });

  test("preserves the original casing of the matched text, not the query's casing", () => {
    const html = render("ANKIT BHATT was named banker of the year", "ankit bhatt");
    expect(html).toContain(">ANKIT BHATT</mark>");
  });

  test("matches the query as one phrase, not each word independently", () => {
    const html = render("Ankit visited the Bhatt residence separately", "Ankit Bhatt");
    expect(html).not.toContain("<mark");
  });

  test("wraps every occurrence, not just the first", () => {
    const html = render("Tesla recalls cars. Tesla stock jumps. Tesla wins again.", "Tesla");
    expect(html.split("<mark").length - 1).toBe(3);
  });

  test("returns the text completely unwrapped when the query is empty", () => {
    expect(highlightMatches("Some headline", "")).toBe("Some headline");
    expect(highlightMatches("Some headline", null)).toBe("Some headline");
    expect(highlightMatches("Some headline", undefined)).toBe("Some headline");
    expect(highlightMatches("Some headline", "   ")).toBe("Some headline");
  });

  test("returns the text unwrapped when the query does not occur in it", () => {
    expect(highlightMatches("Completely unrelated headline", "Ankit Bhatt")).toBe(
      "Completely unrelated headline",
    );
  });

  test("a regex-special-character query is treated as a literal string, not a pattern", () => {
    const html = render("Pricing: $50 (was $75)", "$50");
    expect(html).toContain(">$50</mark>");
  });

  test("handles an empty text without throwing", () => {
    expect(highlightMatches("", "Ankit")).toBe("");
  });
});
