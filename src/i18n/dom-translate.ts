import { translatePhrase } from "./dictionary";
import type { LangCode } from "./languages";

/**
 * Whole-app translation layer.
 *
 * The app's ~30 route files hold their copy as inline JSX rather than message
 * keys, so instead of threading a `t()` call through every screen this walks the
 * rendered DOM and swaps recognised English strings for the active language.
 * The English source is remembered per node, so switching back is lossless.
 *
 * Opt a subtree out with `data-no-translate` (used for the UTC clock, raw feed
 * payloads, identifiers and anything else that must stay verbatim).
 */

const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "CODE",
  "PRE",
  "TEXTAREA",
  "SVG",
  "CANVAS",
  "IFRAME",
  "OBJECT",
]);

const TRANSLATABLE_ATTRS = ["placeholder", "title", "aria-label", "alt"] as const;
type TranslatableAttr = (typeof TRANSLATABLE_ATTRS)[number];

/**
 * `source` is the English original; `rendered` is what we last wrote. If the DOM
 * no longer holds `rendered`, React has replaced the copy and `source` is stale.
 */
interface Tracked {
  source: string;
  rendered: string;
}

const textState = new WeakMap<Text, Tracked>();
const attrState = new WeakMap<Element, Map<TranslatableAttr, Tracked>>();

let observer: MutationObserver | null = null;
let currentLang: LangCode = "en";
let frame = 0;
let applying = false;

function resolveSource(current: string, tracked: Tracked | undefined): string {
  if (tracked && tracked.rendered === current) return tracked.source;
  return current;
}

function applyToTextNode(node: Text, lang: LangCode) {
  const current = node.nodeValue ?? "";
  if (!current.trim()) return;

  const tracked = textState.get(node);
  const source = resolveSource(current, tracked);
  const next = lang === "en" ? source : translatePhrase(source, lang);

  if (next === source && !tracked) return; // Nothing translatable — don't track it.
  if (node.nodeValue !== next) node.nodeValue = next;
  textState.set(node, { source, rendered: next });
}

function applyToAttrs(el: Element, lang: LangCode) {
  for (const attr of TRANSLATABLE_ATTRS) {
    const current = el.getAttribute(attr);
    if (!current || !current.trim()) continue;

    const map = attrState.get(el);
    const tracked = map?.get(attr);
    const source = resolveSource(current, tracked);
    const next = lang === "en" ? source : translatePhrase(source, lang);

    if (next === source && !tracked) continue;
    if (current !== next) el.setAttribute(attr, next);

    const target = map ?? new Map<TranslatableAttr, Tracked>();
    target.set(attr, { source, rendered: next });
    if (!map) attrState.set(el, target);
  }
}

function sweep(root: Node, lang: LangCode) {
  if (typeof document === "undefined") return;

  applying = true;
  try {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as Element;
          if (
            SKIP_TAGS.has(el.tagName) ||
            el.hasAttribute("data-no-translate") ||
            el.getAttribute("contenteditable") === "true"
          ) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
        return (node.nodeValue ?? "").trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });

    // TreeWalker never visits the root itself.
    if (root.nodeType === Node.ELEMENT_NODE) applyToAttrs(root as Element, lang);

    let node = walker.nextNode();
    while (node) {
      if (node.nodeType === Node.TEXT_NODE) applyToTextNode(node as Text, lang);
      else applyToAttrs(node as Element, lang);
      node = walker.nextNode();
    }
  } finally {
    applying = false;
    // Drop the mutation records our own writes produced so we don't re-enter.
    observer?.takeRecords();
  }
}

function scheduleSweep() {
  if (typeof window === "undefined" || frame) return;
  frame = window.requestAnimationFrame(() => {
    frame = 0;
    sweep(document.body, currentLang);
  });
}

function ensureObserver() {
  if (observer || typeof MutationObserver === "undefined") return;
  observer = new MutationObserver((records) => {
    if (applying) return;
    const relevant = records.some(
      (r) =>
        r.type === "characterData" ||
        r.addedNodes.length > 0 ||
        (r.type === "attributes" &&
          TRANSLATABLE_ATTRS.includes(r.attributeName as TranslatableAttr)),
    );
    if (relevant) scheduleSweep();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...TRANSLATABLE_ATTRS],
  });
}

/**
 * Point the translator at a language. Re-runs over the whole document and keeps
 * watching for React re-renders and route changes until called again.
 */
export function setTranslationLanguage(lang: LangCode) {
  if (typeof document === "undefined") return;
  currentLang = lang;
  ensureObserver();
  sweep(document.body, lang);
}

/** Detach the observer and restore every tracked node to English. */
export function stopTranslation() {
  if (typeof document === "undefined") return;
  if (frame) {
    window.cancelAnimationFrame(frame);
    frame = 0;
  }
  observer?.disconnect();
  observer = null;
  currentLang = "en";
  sweep(document.body, "en");
}
