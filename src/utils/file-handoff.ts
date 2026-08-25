/**
 * In-memory hand-off of a File between pages — e.g. the search bar's
 * "Continue in Image Intelligence" action.
 *
 * Mirrors graph-store.ts's "View in Graph" hand-off pattern, with one
 * necessary difference: a File object cannot be JSON-serialised into
 * localStorage, so this is a MODULE-SCOPED IN-MEMORY slot, not a persisted
 * one — and is therefore lost on a full page reload, which is correct,
 * since the File object itself would be too.
 */

export interface FileHandoff {
  file: File;
  /** Where the file came from, so the destination page can explain why it's pre-filled. */
  source: string;
}

let pending: FileHandoff | null = null;

export function setFileHandoff(file: File, source: string): void {
  pending = { file, source };
}

/** Consume the pending hand-off, if any. Read-once — calling this clears it. */
export function takeFileHandoff(): FileHandoff | null {
  const current = pending;
  pending = null;
  return current;
}
