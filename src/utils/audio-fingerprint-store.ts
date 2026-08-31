/**
 * Saved audio reference fingerprints for /videos' Audio spectral analysis
 * panel — lets an analyst save a clip's real measured spectral fingerprint
 * under a name ("Big Ben strike") and later compare a new clip against
 * everything saved. The audio analogue of the image-corpus store behind
 * findNearDuplicates in imaging.ts: matches only against references an
 * analyst actually supplied, never identifies a sound from nothing.
 *
 * Mirrors bookmark-store.ts's own conventions: the caller passes `nowIso`
 * in rather than this file calling `new Date()` itself, every read/write is
 * SSR-safe and wrapped so a full or unavailable localStorage degrades to an
 * unaffected in-memory list rather than throwing.
 */

import type { AudioFingerprint } from "./audio-frequency";

export const AUDIO_REFERENCE_KEY = "sentinel_audio_references";

export interface StoredAudioReference {
  id: string;
  name: string;
  fingerprint: AudioFingerprint;
  savedAt: string;
  /** What clip this came from, for the analyst's own recall — e.g. a filename. Never invented if the caller has nothing real to put here. */
  sourceLabel: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFingerprint(v: unknown): v is AudioFingerprint {
  if (!isRecord(v)) return false;
  return (
    typeof v.referenceHz === "number" &&
    Array.isArray(v.partialRatios) &&
    (v.harmonicRatio === null || typeof v.harmonicRatio === "number") &&
    Array.isArray(v.bandFraction)
  );
}

/** Exported so the parse/validate step is testable without a browser. Rejects malformed entries individually rather than discarding the whole corpus. */
export function parseAudioReferences(raw: unknown): StoredAudioReference[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredAudioReference[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const { id, name, fingerprint, savedAt, sourceLabel } = entry;
    if (typeof id !== "string" || !id) continue;
    if (typeof name !== "string" || !name.trim()) continue;
    if (!isFingerprint(fingerprint)) continue;
    if (typeof savedAt !== "string") continue;
    out.push({
      id,
      name,
      fingerprint,
      savedAt,
      sourceLabel: typeof sourceLabel === "string" ? sourceLabel : "",
    });
  }
  return out;
}

export function getAudioReferences(): StoredAudioReference[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(AUDIO_REFERENCE_KEY);
    if (!raw) return [];
    return parseAudioReferences(JSON.parse(raw));
  } catch {
    return [];
  }
}

function persist(list: StoredAudioReference[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(AUDIO_REFERENCE_KEY, JSON.stringify(list));
  } catch {
    /* quota, or storage unavailable — the caller's in-memory list is unaffected */
  }
}

/**
 * A real bug this project already hit once (evidence-store.ts's own
 * nextEvidenceId history): computing an id from the list's current length
 * reuses an id the moment anything is ever deleted. crypto.randomUUID
 * sidesteps that class of bug entirely rather than needing a counter.
 */
function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `aref-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export function saveAudioReference(
  list: StoredAudioReference[],
  input: { name: string; fingerprint: AudioFingerprint; sourceLabel: string },
  nowIso: string,
): StoredAudioReference[] {
  const next = [
    { id: newId(), name: input.name, fingerprint: input.fingerprint, savedAt: nowIso, sourceLabel: input.sourceLabel },
    ...list,
  ];
  persist(next);
  return next;
}

export function deleteAudioReference(list: StoredAudioReference[], id: string): StoredAudioReference[] {
  const next = list.filter((r) => r.id !== id);
  persist(next);
  return next;
}
