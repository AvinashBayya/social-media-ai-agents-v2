export type LangCode =
  | "en"
  | "as"
  | "bn"
  | "gu"
  | "kn"
  | "ks"
  | "kok"
  | "ml"
  | "mr"
  | "ne"
  | "or"
  | "pa"
  | "sa"
  | "ta"
  | "te"
  | "ur";

export type TranslatedLang = Exclude<LangCode, "en">;

export interface LanguageMeta {
  code: LangCode;
  /** English name, shown as the secondary label. */
  label: string;
  /** Endonym — the language's own name, shown as the primary label. */
  native: string;
  /** Short tag rendered in the collapsed sidebar rail. */
  short: string;
  /** BCP-47 tag written to <html lang>. */
  htmlLang: string;
  /** Font stack applied while this language is active. */
  fontStack: string;
  /** True for Perso-Arabic scripts, which need right-to-left text flow. */
  rtl?: boolean;
}

const BENGALI_FONTS =
  '"Noto Sans Bengali", "Noto Serif Bengali", "Nirmala UI", "Shonar Bangla", "Vrinda", sans-serif';
const DEVANAGARI_FONTS =
  '"Noto Sans Devanagari", "Nirmala UI", "Mangal", "Kokila", "Utsaah", sans-serif';
const NASTALIQ_FONTS =
  '"Noto Nastaliq Urdu", "Jameel Noori Nastaleeq", "Urdu Typesetting", "Noto Naskh Arabic", "Segoe UI", serif';

/**
 * The fifteen scheduled languages offered by the switcher, ordered the way they
 * are conventionally listed (alphabetically by English name), with English first.
 */
export const LANGUAGES: LanguageMeta[] = [
  {
    code: "en",
    label: "English",
    native: "English",
    short: "EN",
    htmlLang: "en",
    fontStack: "",
  },
  {
    code: "as",
    label: "Assamese",
    native: "অসমীয়া",
    short: "AS",
    htmlLang: "as-IN",
    fontStack: BENGALI_FONTS,
  },
  {
    code: "bn",
    label: "Bengali",
    native: "বাংলা",
    short: "BN",
    htmlLang: "bn-IN",
    fontStack: BENGALI_FONTS,
  },
  {
    code: "gu",
    label: "Gujarati",
    native: "ગુજરાતી",
    short: "GU",
    htmlLang: "gu-IN",
    fontStack: '"Noto Sans Gujarati", "Nirmala UI", "Shruti", sans-serif',
  },
  {
    code: "kn",
    label: "Kannada",
    native: "ಕನ್ನಡ",
    short: "KN",
    htmlLang: "kn-IN",
    fontStack: '"Noto Sans Kannada", "Nirmala UI", "Tunga", sans-serif',
  },
  {
    code: "ks",
    label: "Kashmiri",
    native: "کٲشُر",
    short: "KS",
    htmlLang: "ks-Arab-IN",
    fontStack: NASTALIQ_FONTS,
    rtl: true,
  },
  {
    code: "kok",
    label: "Konkani",
    native: "कोंकणी",
    short: "KOK",
    htmlLang: "kok-IN",
    fontStack: DEVANAGARI_FONTS,
  },
  {
    code: "ml",
    label: "Malayalam",
    native: "മലയാളം",
    short: "ML",
    htmlLang: "ml-IN",
    fontStack: '"Noto Sans Malayalam", "Nirmala UI", "Kartika", sans-serif',
  },
  {
    code: "mr",
    label: "Marathi",
    native: "मराठी",
    short: "MR",
    htmlLang: "mr-IN",
    fontStack: DEVANAGARI_FONTS,
  },
  {
    code: "ne",
    label: "Nepali",
    native: "नेपाली",
    short: "NE",
    htmlLang: "ne-NP",
    fontStack: DEVANAGARI_FONTS,
  },
  {
    code: "or",
    label: "Oriya",
    native: "ଓଡ଼ିଆ",
    short: "OR",
    htmlLang: "or-IN",
    fontStack: '"Noto Sans Oriya", "Nirmala UI", "Kalinga", sans-serif',
  },
  {
    code: "pa",
    label: "Punjabi",
    native: "ਪੰਜਾਬੀ",
    short: "PA",
    htmlLang: "pa-IN",
    fontStack: '"Noto Sans Gurmukhi", "Nirmala UI", "Raavi", sans-serif',
  },
  {
    code: "sa",
    label: "Sanskrit",
    native: "संस्कृतम्",
    short: "SA",
    htmlLang: "sa-IN",
    fontStack: DEVANAGARI_FONTS,
  },
  {
    code: "ta",
    label: "Tamil",
    native: "தமிழ்",
    short: "TA",
    htmlLang: "ta-IN",
    fontStack: '"Noto Sans Tamil", "Nirmala UI", "Latha", sans-serif',
  },
  {
    code: "te",
    label: "Telugu",
    native: "తెలుగు",
    short: "TE",
    htmlLang: "te-IN",
    fontStack: '"Noto Sans Telugu", "Nirmala UI", "Gautami", sans-serif',
  },
  {
    code: "ur",
    label: "Urdu",
    native: "اردو",
    short: "UR",
    htmlLang: "ur-IN",
    fontStack: NASTALIQ_FONTS,
    rtl: true,
  },
];

export const DEFAULT_LANG: LangCode = "en";

export const LANG_STORAGE_KEY = "sentinel_lang";

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));

export function getLanguageMeta(code: LangCode): LanguageMeta {
  return BY_CODE.get(code) ?? LANGUAGES[0];
}

export function isLangCode(value: unknown): value is LangCode {
  return typeof value === "string" && BY_CODE.has(value as LangCode);
}
