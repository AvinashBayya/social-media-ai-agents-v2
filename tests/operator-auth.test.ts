import { beforeEach, describe, expect, it } from "bun:test";

import {
  MIN_TOKEN_LENGTH,
  OPERATOR_TOKEN_HEADER,
  configuredOperatorToken,
  operatorTokenFrom,
  requireOperator,
  resetOperatorAuthWarning,
  tokensMatch,
  vaultAuthStatus,
} from "../src/utils/operator-auth";
import { NotAuthorisedError } from "../src/utils/operational-error";

const GOOD = "a-sufficiently-long-operator-token";

function headers(map: Record<string, string>) {
  const lower = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (n: string) => lower[n.toLowerCase()] ?? null };
}

beforeEach(() => resetOperatorAuthWarning());

describe("configuredOperatorToken", () => {
  it("returns null when unset", () => {
    expect(configuredOperatorToken({}, () => {})).toBeNull();
  });

  it("REFUSES a short token rather than reporting protection it cannot provide", () => {
    const warnings: string[] = [];
    expect(
      configuredOperatorToken({ SENTINEL_OPERATOR_TOKEN: "test" }, (m) => warnings.push(m)),
    ).toBeNull();
    expect(warnings[0]).toContain("guessable token is worse");
  });

  it("accepts a token at the minimum length", () => {
    const token = "x".repeat(MIN_TOKEN_LENGTH);
    expect(configuredOperatorToken({ SENTINEL_OPERATOR_TOKEN: token }, () => {})).toBe(token);
  });
});

describe("tokensMatch", () => {
  it("matches identical tokens and rejects others", () => {
    expect(tokensMatch(GOOD, GOOD)).toBe(true);
    expect(tokensMatch(GOOD, `${GOOD}x`)).toBe(false);
    expect(tokensMatch("", GOOD)).toBe(false);
    expect(tokensMatch(GOOD, "")).toBe(false);
  });

  it("does not throw on differing lengths", () => {
    // timingSafeEqual throws on unequal buffers; catching that throw would
    // itself be a length oracle, so both sides are hashed first.
    expect(() => tokensMatch("short", GOOD)).not.toThrow();
    expect(tokensMatch("short", GOOD)).toBe(false);
  });
});

describe("requireOperator", () => {
  const env = { SENTINEL_OPERATOR_TOKEN: GOOD };

  it("permits a matching token", () => {
    expect(() => requireOperator("addCredential", GOOD, env, () => {})).not.toThrow();
  });

  it("refuses a wrong or absent token", () => {
    expect(() => requireOperator("addCredential", "nope", env, () => {})).toThrow(
      NotAuthorisedError,
    );
    expect(() => requireOperator("addCredential", null, env, () => {})).toThrow(NotAuthorisedError);
  });

  it("permits but logs ONCE when no token is configured", () => {
    const logs: string[] = [];
    requireOperator("addCredential", null, {}, (m) => logs.push(m));
    requireOperator("addCredential", null, {}, (m) => logs.push(m));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("without authentication");
  });
});

describe("vaultAuthStatus", () => {
  it("reports unprotected and names the env var that closes it", () => {
    const status = vaultAuthStatus({}, () => {});
    expect(status.mode).toBe("unprotected");
    expect(status.envVar).toBe("SENTINEL_OPERATOR_TOKEN");
    expect(status.detail).toContain("add, overwrite or delete");
  });

  it("states plainly that secrets are never readable, even when unprotected", () => {
    // This is the claim the redaction fix earned, and the UI repeats it. If
    // any server function starts returning a secret again, this sentence
    // becomes false and must change with it.
    expect(vaultAuthStatus({}, () => {}).detail).toContain("never readable");
  });

  it("reports protected when a token is set", () => {
    expect(vaultAuthStatus({ SENTINEL_OPERATOR_TOKEN: GOOD }, () => {}).mode).toBe("protected");
  });
});

describe("operatorTokenFrom", () => {
  it("reads the dedicated header", () => {
    expect(operatorTokenFrom(headers({ [OPERATOR_TOKEN_HEADER]: GOOD }))).toBe(GOOD);
  });

  it("accepts Authorization: Bearer so ordinary tooling works", () => {
    expect(operatorTokenFrom(headers({ authorization: `Bearer ${GOOD}` }))).toBe(GOOD);
  });

  it("returns null when neither is present", () => {
    expect(operatorTokenFrom(headers({}))).toBeNull();
    expect(operatorTokenFrom(headers({ authorization: "Basic abc" }))).toBeNull();
  });
});
