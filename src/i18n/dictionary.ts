import as_ from "./locales/as";
import bn from "./locales/bn";
import gu from "./locales/gu";
import kn from "./locales/kn";
import kok from "./locales/kok";
import ks from "./locales/ks";
import ml from "./locales/ml";
import mr from "./locales/mr";
import ne from "./locales/ne";
import or from "./locales/or";
import pa from "./locales/pa";
import sa from "./locales/sa";
import ta from "./locales/ta";
import te from "./locales/te";
import ur from "./locales/ur";
import type { LangCode, TranslatedLang } from "./languages";
import type { Locale } from "./types";

const LOCALES: Record<TranslatedLang, Locale> = {
  as: as_,
  bn,
  gu,
  kn,
  kok,
  ks,
  ml,
  mr,
  ne,
  or,
  pa,
  sa,
  ta,
  te,
  ur,
};

interface CompiledLocale {
  /** Normalised English phrase -> translation. */
  phrases: Map<string, string>;
  /** Lowercase English word -> translation. */
  words: Map<string, string>;
}

function normalizeKey(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[:：]+$/, "")
    .toLowerCase();
}

function compile(locale: Locale): CompiledLocale {
  const phrases = new Map<string, string>();
  for (const [en, value] of Object.entries(locale.phrases)) {
    phrases.set(normalizeKey(en), value);
  }
  const words = new Map<string, string>();
  for (const [en, value] of Object.entries(locale.words)) {
    words.set(en.toLowerCase(), value);
  }
  return { phrases, words };
}

const COMPILED = new Map<TranslatedLang, CompiledLocale>(
  (Object.keys(LOCALES) as TranslatedLang[]).map((code) => [code, compile(LOCALES[code])]),
);

function localeFor(lang: LangCode): CompiledLocale | null {
  return lang === "en" ? null : (COMPILED.get(lang as TranslatedLang) ?? null);
}

/** Fraction of alphabetic words that must be known before a word-level fallback applies. */
const WORD_FALLBACK_COVERAGE = 0.6;

/**
 * Translate a single UI string. Returns the original when the language is
 * English or no confident translation exists.
 */
export function translatePhrase(input: string, lang: LangCode): string {
  const locale = localeFor(lang);
  if (!locale || !input) return input;

  // Preserve leading/trailing whitespace — text nodes often carry layout spacing.
  const leading = input.match(/^\s*/)?.[0] ?? "";
  const trailing = input.match(/\s*$/)?.[0] ?? "";
  const core = input.slice(leading.length, input.length - trailing.length);
  if (!core) return input;

  // Nothing to translate in pure numbers, symbols, or already-translated text.
  if (!/[A-Za-z]/.test(core)) return input;

  const translated = translateCore(core, locale);
  return translated === null ? input : leading + translated + trailing;
}

function translateCore(core: string, locale: CompiledLocale): string | null {
  // 1. Exact phrase, allowing a trailing colon to be re-attached.
  const trailingColon = /[:：]\s*$/.exec(core)?.[0] ?? "";
  const direct = locale.phrases.get(normalizeKey(core));
  if (direct) return direct + trailingColon;

  // 2. Split on separators the UI uses to join independently-translatable parts.
  if (/\s[·|—–/]\s/.test(core)) {
    const parts = core.split(/(\s[·|—–/]\s)/);
    let anyHit = false;
    const mapped = parts.map((part) => {
      if (/^\s[·|—–/]\s$/.test(part)) return part;
      const sub = translateCore(part, locale);
      if (sub !== null) anyHit = true;
      return sub ?? part;
    });
    if (anyHit) return mapped.join("");
  }

  // 3. Word-level fallback for label-style strings the dictionary hasn't seen.
  return translateWordwise(core, locale);
}

function translateWordwise(core: string, locale: CompiledLocale): string | null {
  // Only attempt short label-like strings; long prose degrades badly word-by-word.
  const tokens = core.split(/(\s+|[(),.\-/]+)/);
  const alphaTokens = tokens.filter((t) => /^[A-Za-z]+$/.test(t));
  if (alphaTokens.length === 0 || alphaTokens.length > 6) return null;

  let known = 0;
  const mapped = tokens.map((token) => {
    if (!/^[A-Za-z]+$/.test(token)) return token;
    const value = locale.words.get(token.toLowerCase());
    if (!value) return token;
    known += 1;
    return value;
  });

  if (known / alphaTokens.length < WORD_FALLBACK_COVERAGE) return null;
  return mapped.join("");
}

/** True when the string has at least a partial translation available. */
export function hasTranslation(input: string, lang: LangCode): boolean {
  return translatePhrase(input, lang) !== input;
}

/**
 * Per-language entry counts, plus the English keys each locale defines. Used by
 * the consistency check to catch a locale file that has drifted out of sync.
 */
export function localeCoverage(): Record<TranslatedLang, { phrases: string[]; words: string[] }> {
  const out = {} as Record<TranslatedLang, { phrases: string[]; words: string[] }>;
  for (const code of Object.keys(LOCALES) as TranslatedLang[]) {
    out[code] = {
      phrases: Object.keys(LOCALES[code].phrases),
      words: Object.keys(LOCALES[code].words),
    };
  }
  return out;
}
