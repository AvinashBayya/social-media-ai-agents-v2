/**
 * A locale bundle. `phrases` maps a full English UI string to its translation;
 * `words` maps a single lowercase English word, used as a fallback when a
 * phrase has no exact entry.
 */
export interface Locale {
  phrases: Record<string, string>;
  words: Record<string, string>;
}
