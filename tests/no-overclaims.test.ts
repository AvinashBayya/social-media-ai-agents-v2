import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { NOT_IMPLEMENTED } from "../src/utils/imaging";

/**
 * The UI must not claim a capability the system does not have.
 *
 * `NOT_IMPLEMENTED` in imaging.ts is the declared list of Module 4 capability
 * gaps, and CLAUDE.md states plainly: "We do not build or claim a deepfake
 * classifier." Copy that promises deepfake scoring, object detection, face
 * matching or Whisper transcription contradicts the module's own contract, and
 * on a defence evaluation an overclaim is the most expensive kind of error in
 * this codebase.
 *
 * ── Why this does not fire on the disclaimers ───────────────────────────────
 *
 * This repo comments HEAVILY about fabrications it removed, and those comments
 * quote the forbidden words verbatim ("Deepfake analysis 14%", "Faces 4 · 92%",
 * "a five-line audio transcript"). Several pages also carry deliberate,
 * load-bearing disclaimers that must NAME the gap to be useful — the
 * NotImplementedPanel is a deliverable, not an accident. Two defences keep
 * those out of the results:
 *
 *   1. COMMENTS ARE STRIPPED before matching, by a small lexer that tracks
 *      string state so it does not mangle `https://` or `accept="image/*"`.
 *      An apostrophe does NOT open a string: JSX prose is full of them ("Meta's
 *      terms"), and treating one as a quote leaves the rest of the file looking
 *      like a string, which silently disables comment stripping downstream.
 *   2. A DISCLAIMER GUARD skips any hit whose surrounding 140 characters
 *      contain a negation or gap-declaring word. "No deepfake classifier",
 *      "a deepfake score is a guess, so this system does not produce one" and
 *      "Deepfake detection requires a vision model. None is configured" all
 *      read as disclaimers; a bare feature blurb does not.
 *
 * Both defences are exercised by the control tests below, so a change that
 * quietly defeats either one fails here rather than passing vacuously.
 *
 * The pattern table is keyed to `NOT_IMPLEMENTED`, and a test asserts every
 * declared gap has at least one detector. Declaring a NEW gap without teaching
 * this file to detect claims about it fails the suite.
 */

const ROOT = join(import.meta.dir, "..");

/** Routes and hand-written components. `components/ui` is vendored shadcn. */
const SCAN_DIRS = ["src/routes", "src/components"];
const SKIP_DIRS = ["src/components/ui"];

/**
 * Individual `src/utils` files that hold USER-FACING DISPLAY STRINGS.
 *
 * Added 2026-08-12 after a real escape. `PLATFORM_NOTES` in social.ts claimed
 * single-video downloads are "audit logged" — no audit trail exists anywhere in
 * this system — and `COLLECTION_POLICIES` repeated it. Both strings render on
 * /social inside the policy card, so the claim was on screen and unguarded,
 * because moving copy from a route into a util took it out of SCAN_DIRS while
 * leaving it in front of the analyst.
 *
 * Scoped to named files rather than all of `src/utils`: most of that directory
 * is implementation whose comments discuss these very concepts, and scanning it
 * wholesale would drown real findings. **Any module whose strings reach the UI
 * belongs on this list.**
 */
const SCAN_FILES = ["src/utils/collection-policy.ts", "src/utils/social.ts"];

function posix(p: string): string {
  return relative(ROOT, p).split("\\").join("/");
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (SKIP_DIRS.includes(posix(p))) continue;
      out.push(...walk(p));
    } else if (/\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Blank out line, block and JSX comments, preserving offsets and newlines so
 * line numbers in failures point at the real line.
 *
 * Only a double quote or a backtick opens a string. A single quote is ignored
 * on purpose — see the header note.
 */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  let quote: string | null = null;

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    if (quote) {
      if (c === "\\") {
        out += "  ";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i++;
      continue;
    }

    if (c === '"' || c === "`") {
      quote = c;
      out += c;
      i++;
      continue;
    }

    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let k = i; k < stop; k++) out += src[k] === "\n" ? "\n" : " ";
      i = stop;
      continue;
    }

    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

interface Pattern {
  /** Must equal a `capability` in NOT_IMPLEMENTED, or "" for infrastructure. */
  gap: string;
  re: RegExp;
}

/** Phrasing that asserts a Module 4 capability the system does not have. */
const CLAIM_PATTERNS: Pattern[] = [
  {
    gap: "Deepfake / face-swap detection",
    re: /\bdeep\s?fakes?\b[\s\S]{0,40}?\b(scor\w+|likelihood|probabilit\w+|detect\w+|analys\w+|assess\w+|confidence|classif\w+|percent\w+)\b/gi,
  },
  {
    gap: "Deepfake / face-swap detection",
    re: /\b(scor\w+|likelihood|probabilit\w+|detect\w+|analys\w+|assess\w+|classif\w+)\b[\s\S]{0,40}?\bdeep\s?fakes?\b/gi,
  },
  { gap: "Deepfake / face-swap detection", re: /\bface[- ]?swap\w*\b/gi },
  {
    gap: "Diffusion-generated image detection",
    re: /\b(synthetic[- ]media|ai[- ]generated|diffusion|generative)\b[\s\S]{0,30}?\b(detect\w+|classif\w+|scor\w+|likelihood)\b/gi,
  },
  {
    gap: "Object and materiel recognition",
    re: /\bobject\s+(detection|detector|recognition|count|classif\w+)\b/gi,
  },
  {
    gap: "Object and materiel recognition",
    re: /\bmateriel\s+(detection|recognition|identif\w+)\b/gi,
  },
  { gap: "Object and materiel recognition", re: /\b(objects?|vehicles?|weapons?)\s+detected\b/gi },
  {
    gap: "Face matching against a watchlist",
    re: /\bfac(e|ial)\s+(count|match\w*|recognition|detect\w+|identif\w+)\b/gi,
  },
  { gap: "Face matching against a watchlist", re: /\bfaces\s+(detected|counted|matched)\b/gi },
  { gap: "Audio transcription and voice-clone detection", re: /\bwhisper\b/gi },
  {
    gap: "Audio transcription and voice-clone detection",
    re: /\b(audio|speech|voice)\s+(transcription|transcript|analysis|recognition)\b/gi,
  },
  {
    gap: "Audio transcription and voice-clone detection",
    re: /\btranscript\s+(analysis|extraction|generation)\b/gi,
  },
  {
    gap: "Audio transcription and voice-clone detection",
    re: /\b(voice[- ]clone\w*|speech[- ]to[- ]text|transcrib\w+)\b/gi,
  },
];

/**
 * Assurances about the platform itself that nothing implements.
 *
 * There is no server-side store, no append-only log and no signing key: all
 * state is localStorage in the analyst's own browser. Delete an entry here the
 * day the capability actually ships — this list is not bound to a contract the
 * way CLAIM_PATTERNS is, so it can only be kept honest by hand.
 */
const INFRA_PATTERNS: Pattern[] = [
  { gap: "", re: /\btamper[ -](proof|evident|resistant)\b/gi },
  { gap: "", re: /\baudit[ -](log|logged|logging|trail)\w*\b/gi },
  { gap: "", re: /\bchain[ -]of[ -]custody\b/gi },
  { gap: "", re: /\bend[ -]to[ -]end\s+encrypt\w+\b/gi },
  { gap: "", re: /\bencrypted\s+at\s+rest\b/gi },
];

/**
 * Words that turn a capability mention into a statement about its ABSENCE.
 * Deliberately tight: "unavailable" is excluded, because "Subtitles
 * Unavailable" sat directly above a promise of Whisper transcription and would
 * have excused it.
 */
const DISCLAIMER =
  /\b(no|not|never|none|nothing|neither|nor|without|cannot|can't|absent|unimplemented|lacks?|lacking|would|requires?|required|gaps?|guess|declared|instead|previously|removed|fabricat\w+|invented)\b/i;

/** Characters of context each side of a hit that the guard reads. */
const CONTEXT = 140;

interface Hit {
  file: string;
  line: number;
  gap: string;
  text: string;
  context: string;
}

export function scanSource(file: string, raw: string, patterns: Pattern[]): Hit[] {
  const code = stripComments(raw);
  const hits: Hit[] = [];
  const seen = new Set<string>();

  for (const { gap, re } of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const key = `${gap}@${m.index}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const context = code
        .slice(
          Math.max(0, m.index - CONTEXT),
          Math.min(code.length, m.index + m[0].length + CONTEXT),
        )
        .replace(/[`'"]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (DISCLAIMER.test(context)) continue;

      hits.push({
        file,
        line: code.slice(0, m.index).split("\n").length,
        gap,
        text: m[0],
        context,
      });
    }
  }
  return hits;
}

function scannedFiles(): string[] {
  return [
    ...SCAN_DIRS.flatMap((d) => walk(join(ROOT, d))),
    ...SCAN_FILES.map((f) => join(ROOT, f)),
  ].sort();
}

function scanTree(patterns: Pattern[]): Hit[] {
  return scannedFiles().flatMap((f) => scanSource(posix(f), readFileSync(f, "utf8"), patterns));
}

/** Rendered into the assertion value so a failure names every offender. */
function report(headline: string, hits: Hit[]): string {
  if (hits.length === 0) return "";
  return (
    headline +
    hits
      .map(
        (h) =>
          `\n  ${h.file}:${h.line}` +
          (h.gap ? `\n    declared gap: ${h.gap}` : "") +
          `\n    matched:      ${JSON.stringify(h.text)}` +
          `\n    copy:         ${h.context}`,
      )
      .join("\n")
  );
}

describe("UI does not claim capabilities the system lacks", () => {
  test("every declared NOT_IMPLEMENTED gap has a detector pattern", () => {
    const covered = new Set(CLAIM_PATTERNS.map((p) => p.gap));
    const uncovered = NOT_IMPLEMENTED.map((g) => g.capability).filter((c) => !covered.has(c));
    // A new declared gap needs a CLAIM_PATTERNS entry keyed to its `capability`.
    expect(uncovered).toEqual([]);
  });

  test("no pattern is keyed to a gap that no longer exists", () => {
    const declared = new Set(NOT_IMPLEMENTED.map((g) => g.capability));
    const orphans = [...new Set(CLAIM_PATTERNS.map((p) => p.gap))].filter((g) => !declared.has(g));
    expect(orphans).toEqual([]);
  });

  test("no route or component promises a NOT_IMPLEMENTED capability", () => {
    const summary = report(
      "UI copy claims a capability declared in imaging.ts NOT_IMPLEMENTED. " +
        "Describe what the system genuinely does, or state the gap explicitly — " +
        "the phrasing on /images and in NotImplementedPanel is the model.",
      scanTree(CLAIM_PATTERNS),
    );
    expect(summary).toBe("");
  });

  test("no route or component promises infrastructure that does not exist", () => {
    const summary = report(
      "UI copy asserts tamper-proofing, audit logging or custody tracking. All state is " +
        "localStorage in the analyst's browser: no server-side store, no append-only log, " +
        "no signing key.",
      scanTree(INFRA_PATTERNS),
    );
    expect(summary).toBe("");
  });
});

describe("the overclaim detector itself", () => {
  const claim = `<p className="x">Frame-by-frame object detection, face count and Whisper transcript analysis.</p>`;
  const disclaimer = `<p className="x">No object detection and no face matching are performed. Whisper transcription is not deployed.</p>`;
  const inComment = `/* The old panel read "Deepfake analysis 14%" and listed Faces 4. */\nconst x = 1;`;
  const jsxComment = `{/* Object detection and face count were invented values. */}`;

  test("flags a bare capability claim", () => {
    const hits = scanSource("synthetic.tsx", claim, CLAIM_PATTERNS);
    expect(hits.map((h) => h.text.toLowerCase()).sort()).toEqual([
      "face count",
      "object detection",
      "transcript analysis",
      "whisper",
    ]);
  });

  test("does not flag the same words inside a disclaimer", () => {
    expect(scanSource("synthetic.tsx", disclaimer, CLAIM_PATTERNS)).toEqual([]);
  });

  test("does not flag words inside a block comment", () => {
    expect(scanSource("synthetic.tsx", inComment, CLAIM_PATTERNS)).toEqual([]);
    expect(stripComments(inComment)).not.toContain("Deepfake");
  });

  test("does not flag words inside a JSX comment", () => {
    expect(scanSource("synthetic.tsx", jsxComment, CLAIM_PATTERNS)).toEqual([]);
    expect(stripComments(jsxComment)).not.toContain("Object detection");
  });

  test("an apostrophe in JSX prose does not disable comment stripping", () => {
    const src = `<p>Meta's terms prohibit it.</p>\n{/* Deepfake likelihood scoring was removed. */}`;
    expect(stripComments(src)).not.toContain("Deepfake");
  });

  test("comment stripping leaves string literals intact", () => {
    const src = `const a = "https://example.com/x"; const b = <input accept="image/*" />;`;
    expect(stripComments(src)).toBe(src);
  });

  test("infra patterns flag an audit-log claim and spare its denial", () => {
    expect(
      scanSource("synthetic.tsx", `<p>Each download is audit logged.</p>`, INFRA_PATTERNS),
    ).toHaveLength(1);
    expect(
      scanSource("synthetic.tsx", `<p>Nothing keeps an audit log.</p>`, INFRA_PATTERNS),
    ).toEqual([]);
  });

  test("it actually reads the shipped routes", () => {
    const files = scannedFiles();
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => posix(f) === "src/routes/index.tsx")).toBe(true);
    expect(files.some((f) => posix(f) === "src/components/not-implemented.tsx")).toBe(true);
  });

  test("it also reads the util modules whose strings render on screen", () => {
    // The escape this list exists to close: an "audit logged" claim sitting in
    // PLATFORM_NOTES and COLLECTION_POLICIES, rendered on /social, unscanned.
    const files = scannedFiles().map(posix);
    for (const f of SCAN_FILES) expect(files).toContain(f);
  });
});
