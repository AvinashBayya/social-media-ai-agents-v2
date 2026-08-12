/**
 * Evidence integrity primitives, shared by every path that accepts an analyst
 * file.
 *
 * Extracted from `routes/vault.tsx` on 2026-08-12, where `sha256OfFile` was an
 * inline closure. The manual capture panel on /social needs exactly the same
 * hash under exactly the same secure-context rules, and two copies of a hashing
 * function is how two evidence records end up with different notions of what
 * "the same file" means.
 *
 * The rule the original comment states, kept verbatim in spirit: an evidence
 * hash that is not derived from the evidence defeats the purpose of recording
 * one. It was 64 random hex characters before that fix. Never restore a
 * fallback here — if the hash cannot be computed, the caller must refuse the
 * upload rather than store something that merely looks like a digest.
 */

/** Thrown when a file cannot be hashed. Never swallowed into a fake digest. */
export class EvidenceIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceIntegrityError";
  }
}

/**
 * SHA-256 over the file's bytes, lowercase hex.
 *
 * Uses SubtleCrypto, which requires a secure context. Over plain HTTP on a
 * non-localhost origin it is simply unavailable, and that is reported rather
 * than worked around — a "hash" produced by a fallback would still render as a
 * green integrity chip while proving nothing.
 */
export async function sha256OfFile(file: Blob): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new EvidenceIntegrityError(
      "SubtleCrypto unavailable — a secure context (HTTPS or localhost) is required to hash " +
        "evidence. The file was not stored, because an unhashed evidence record cannot be " +
        "shown to be unaltered later.",
    );
  }
  const buf = await file.arrayBuffer();
  const digest = await globalThis.crypto.subtle.digest("SHA-256", buf);
  return bytesToHex(new Uint8Array(digest));
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** A well-formed SHA-256 digest: 64 lowercase hex characters. */
export function isSha256(value: unknown): boolean {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * What a SHA-256 over an analyst's upload does and does not establish.
 *
 * Rendered next to the digest wherever one is shown. A hash of a screenshot
 * proves the file has not changed since it was added; it says nothing about
 * whether the screenshot faithfully depicts the post, whether the post existed,
 * or whether the account is who it claims to be. Displaying a bare green
 * "verified" chip invites all three of those readings.
 */
export const HASH_MEANING =
  "This SHA-256 is computed over the uploaded file. It proves the file has not been altered " +
  "since it entered the vault. It does not authenticate the content: it cannot show that a " +
  "screenshot faithfully depicts the post it claims to, that the post existed, or that the " +
  "account is genuine. Those remain analyst judgements.";
