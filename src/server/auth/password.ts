import { argon2id, argon2Verify } from "hash-wasm";

/**
 * Password hashing — Argon2id.
 *
 * Implemented with `hash-wasm` (MIT) rather than the `argon2` npm package,
 * which is a native C++ addon. The runtime container stage copies `.output`
 * only and runs on Alpine/musl, where a node-gyp addon either fails to load or
 * has to be rebuilt from source. hash-wasm is a WebAssembly build: it runs
 * identically under Bun, Node and the browser, needs no toolchain, and matches
 * the WASM-first precedent already set by the imaging module (c2pa, tesseract).
 *
 * Output is the standard PHC string:
 *   $argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>
 * Parameters are embedded, so `verifyPassword` keeps working against hashes
 * created under older settings and `needsRehash` reports which ones to upgrade
 * on next successful login.
 */

export interface Argon2Params {
  /** Memory cost in kibibytes. */
  memoryKib: number;
  /** Time cost — number of passes. */
  iterations: number;
  /** Lanes. */
  parallelism: number;
}

/**
 * OWASP baseline for Argon2id (19 MiB, t=2, p=1). Kept here as the fallback
 * used by tests and the seed script; the running server takes these from the
 * environment so they can be raised without a code change.
 */
export const DEFAULT_ARGON2_PARAMS: Argon2Params = {
  memoryKib: 19456,
  iterations: 2,
  parallelism: 1,
};

const SALT_BYTES = 16;
const HASH_BYTES = 32;

function randomSalt(): Uint8Array {
  const salt = new Uint8Array(SALT_BYTES);
  // Web Crypto is global in Node 18+, Bun and the browser. Deliberately not
  // Math.random, which is banned project-wide and is not a CSPRNG anyway.
  crypto.getRandomValues(salt);
  return salt;
}

/** Hash a plaintext password. Returns a self-describing PHC string. */
export async function hashPassword(
  plaintext: string,
  params: Argon2Params = DEFAULT_ARGON2_PARAMS,
): Promise<string> {
  if (!plaintext) throw new Error("Refusing to hash an empty password.");

  return argon2id({
    password: plaintext,
    salt: randomSalt(),
    memorySize: params.memoryKib,
    iterations: params.iterations,
    parallelism: params.parallelism,
    hashLength: HASH_BYTES,
    outputType: "encoded",
  });
}

/**
 * Verify a password against a stored PHC hash.
 *
 * Returns false rather than throwing on a malformed or unrecognised hash: a
 * corrupt row must fail the login, not crash the request and reveal — through
 * a 500 where other accounts give a 401 — that this particular account exists.
 */
export async function verifyPassword(plaintext: string, storedHash: string): Promise<boolean> {
  if (!plaintext || !storedHash) return false;

  try {
    return await argon2Verify({ password: plaintext, hash: storedHash });
  } catch {
    return false;
  }
}

/**
 * A valid Argon2id hash of a value no one can present, used to spend the same
 * CPU time when the submitted username does not exist. Without this, a missing
 * account returns in microseconds while a real one takes ~50ms, and that gap
 * is a reliable username oracle.
 *
 * Computed once, lazily, and reused.
 */
let dummyHashPromise: Promise<string> | null = null;

function dummyHash(params: Argon2Params): Promise<string> {
  if (!dummyHashPromise) {
    const unguessable = new Uint8Array(32);
    crypto.getRandomValues(unguessable);
    dummyHashPromise = hashPassword(Buffer.from(unguessable).toString("base64"), params);
  }
  return dummyHashPromise;
}

/**
 * Burn roughly one password verification's worth of time. Call on the
 * "user not found" branch of login so its latency matches the "wrong
 * password" branch.
 */
export async function spendDummyVerification(
  plaintext: string,
  params: Argon2Params = DEFAULT_ARGON2_PARAMS,
): Promise<void> {
  try {
    await argon2Verify({ password: plaintext, hash: await dummyHash(params) });
  } catch {
    // The result is discarded by design — only the elapsed time matters.
  }
}

const PHC_PATTERN = /^\$argon2(id|i|d)\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$/;

export interface ParsedPhc {
  variant: "argon2id" | "argon2i" | "argon2d";
  version: number;
  params: Argon2Params;
}

/** Read the algorithm parameters back out of a stored hash. Null if unparseable. */
export function parsePhc(storedHash: string): ParsedPhc | null {
  const match = PHC_PATTERN.exec(storedHash);
  if (!match) return null;

  return {
    variant: `argon2${match[1]}` as ParsedPhc["variant"],
    version: Number(match[2]),
    params: {
      memoryKib: Number(match[3]),
      iterations: Number(match[4]),
      parallelism: Number(match[5]),
    },
  };
}

/**
 * True when a stored hash was produced with weaker settings than the ones now
 * configured, or with a variant other than Argon2id. The login path rehashes
 * these transparently once the password has been proven correct — that is the
 * only moment the plaintext is available to do it.
 */
export function needsRehash(storedHash: string, target: Argon2Params): boolean {
  const parsed = parsePhc(storedHash);
  if (!parsed) return true;
  if (parsed.variant !== "argon2id") return true;

  return (
    parsed.params.memoryKib < target.memoryKib ||
    parsed.params.iterations < target.iterations ||
    parsed.params.parallelism !== target.parallelism
  );
}
