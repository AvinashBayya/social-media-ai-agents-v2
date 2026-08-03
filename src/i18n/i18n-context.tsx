import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { translatePhrase } from "./dictionary";
import { setTranslationLanguage, stopTranslation } from "./dom-translate";
import {
  DEFAULT_LANG,
  LANG_STORAGE_KEY,
  getLanguageMeta,
  isLangCode,
  type LangCode,
  type LanguageMeta,
} from "./languages";

interface I18nValue {
  lang: LangCode;
  meta: LanguageMeta;
  setLang: (lang: LangCode) => void;
  /** Translate a string explicitly (the DOM layer handles untouched JSX). */
  t: (input: string) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

const LANG_CHANGED_EVENT = "sentinel_lang_changed";

function readStoredLang(): LangCode {
  if (typeof window === "undefined") return DEFAULT_LANG;
  try {
    const stored = window.localStorage.getItem(LANG_STORAGE_KEY);
    return isLangCode(stored) ? stored : DEFAULT_LANG;
  } catch {
    return DEFAULT_LANG;
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  // Always start at English so SSR markup and the first client render agree;
  // the stored preference is applied in the effect below.
  const [lang, setLangState] = useState<LangCode>(DEFAULT_LANG);

  useEffect(() => {
    const stored = readStoredLang();
    if (stored !== DEFAULT_LANG) setLangState(stored);

    const onExternalChange = (e: Event) => {
      const next = (e as CustomEvent<LangCode>).detail;
      if (isLangCode(next)) setLangState(next);
    };
    window.addEventListener(LANG_CHANGED_EVENT, onExternalChange);
    return () => window.removeEventListener(LANG_CHANGED_EVENT, onExternalChange);
  }, []);

  useEffect(() => {
    const meta = getLanguageMeta(lang);
    const root = document.documentElement;

    root.setAttribute("lang", meta.htmlLang);
    root.dataset.lang = lang;
    // Indic scripts need taller line boxes than the Latin defaults.
    root.style.setProperty("--app-font-stack", meta.fontStack);
    root.classList.toggle("lang-indic", lang !== "en");
    // Perso-Arabic scripts (Urdu, Kashmiri) need right-to-left text flow.
    root.classList.toggle("lang-rtl", Boolean(meta.rtl));

    if (lang === "en") stopTranslation();
    else setTranslationLanguage(lang);
  }, [lang]);

  const setLang = useCallback((next: LangCode) => {
    setLangState(next);
    try {
      window.localStorage.setItem(LANG_STORAGE_KEY, next);
    } catch {
      /* storage unavailable — the choice just won't persist */
    }
    window.dispatchEvent(new CustomEvent<LangCode>(LANG_CHANGED_EVENT, { detail: next }));
  }, []);

  const value = useMemo<I18nValue>(
    () => ({
      lang,
      meta: getLanguageMeta(lang),
      setLang,
      t: (input: string) => translatePhrase(input, lang),
    }),
    [lang, setLang],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside <I18nProvider>");
  return ctx;
}

/** Convenience hook for components that only need the translate function. */
export function useT() {
  return useI18n().t;
}
