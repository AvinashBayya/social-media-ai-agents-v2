import { describe, expect, test } from "bun:test";

import {
  DEMO_OPERATOR,
  DEMO_PASSWORD,
  DemoSessionSchema,
  createDemoSession,
  demoProfileFor,
  parseDemoSession,
  safeRedirectTarget,
  verifyDemoCredentials,
} from "../src/utils/demo-session";

/**
 * These cover the demo session store. They assert that it behaves predictably,
 * NOT that it is secure — it is a client-side mock and cannot be. The one
 * security-shaped test here is the open-redirect guard, which is a real
 * defect class regardless of whether the session behind it is genuine.
 */

describe("verifyDemoCredentials", () => {
  test("accepts the published demo pair", () => {
    expect(verifyDemoCredentials(DEMO_OPERATOR, DEMO_PASSWORD)).toBe(true);
  });

  test("tolerates surrounding whitespace on the operator, a paste artefact", () => {
    expect(verifyDemoCredentials(`  ${DEMO_OPERATOR}  `, DEMO_PASSWORD)).toBe(true);
  });

  test("rejects a wrong password", () => {
    expect(verifyDemoCredentials(DEMO_OPERATOR, "admin@1234")).toBe(false);
    expect(verifyDemoCredentials(DEMO_OPERATOR, "")).toBe(false);
  });

  test("rejects a wrong operator", () => {
    expect(verifyDemoCredentials("admin", DEMO_PASSWORD)).toBe(false);
    expect(verifyDemoCredentials("", DEMO_PASSWORD)).toBe(false);
  });

  test("does not trim the password — whitespace is part of it", () => {
    expect(verifyDemoCredentials(DEMO_OPERATOR, ` ${DEMO_PASSWORD} `)).toBe(false);
  });

  test("is case sensitive", () => {
    expect(verifyDemoCredentials(DEMO_OPERATOR, DEMO_PASSWORD.toUpperCase())).toBe(false);
  });
});

describe("createDemoSession", () => {
  test("produces a record matching the schema", () => {
    const s = createDemoSession(DEMO_OPERATOR, true, "2026-08-07T09:00:00.000Z");
    expect(DemoSessionSchema.safeParse(s).success).toBe(true);
    expect(s.operator).toBe(DEMO_OPERATOR);
    expect(s.remember).toBe(true);
    expect(s.signedInAt).toBe("2026-08-07T09:00:00.000Z");
  });

  test("trims the operator it stores", () => {
    expect(createDemoSession("  admin@  ", false, "2026-08-07T09:00:00.000Z").operator).toBe(
      "admin@",
    );
  });

  test("carries no secret — the record must never hold the password", () => {
    const s = createDemoSession(DEMO_OPERATOR, false, "2026-08-07T09:00:00.000Z");
    expect(JSON.stringify(s)).not.toContain(DEMO_PASSWORD);
  });
});

describe("demoProfileFor", () => {
  test("is a fixed profile, not an invented user record", () => {
    const a = demoProfileFor("admin@");
    const b = demoProfileFor("someone.else");
    expect(a.displayName).toBe(b.displayName);
    expect(a.email).toBe(b.email);
    expect(a.operator).toBe("admin@");
  });
});

describe("parseDemoSession", () => {
  const valid = JSON.stringify(createDemoSession(DEMO_OPERATOR, false, "2026-08-07T09:00:00.000Z"));

  test("round-trips a valid record", () => {
    expect(parseDemoSession(valid)?.operator).toBe(DEMO_OPERATOR);
  });

  test("returns null for null, empty and non-JSON input", () => {
    expect(parseDemoSession(null)).toBeNull();
    expect(parseDemoSession("")).toBeNull();
    expect(parseDemoSession("not json {{{")).toBeNull();
  });

  test("returns null rather than repairing a partial record", () => {
    expect(parseDemoSession(JSON.stringify({ operator: "admin@" }))).toBeNull();
  });

  test("returns null for wrong field types", () => {
    const bad = { ...JSON.parse(valid), remember: "yes" };
    expect(parseDemoSession(JSON.stringify(bad))).toBeNull();
  });

  test("returns null for a JSON array or primitive", () => {
    expect(parseDemoSession("[]")).toBeNull();
    expect(parseDemoSession('"admin@"')).toBeNull();
    expect(parseDemoSession("null")).toBeNull();
  });
});

describe("safeRedirectTarget", () => {
  test("allows a same-origin absolute path", () => {
    expect(safeRedirectTarget("/gis")).toBe("/gis");
    expect(safeRedirectTarget("/reports?tab=1")).toBe("/reports?tab=1");
  });

  test("falls back when absent", () => {
    expect(safeRedirectTarget(undefined)).toBe("/");
    expect(safeRedirectTarget("")).toBe("/");
  });

  test("rejects absolute URLs — an off-site bounce", () => {
    expect(safeRedirectTarget("https://evil.example/x")).toBe("/");
    expect(safeRedirectTarget("http://evil.example")).toBe("/");
  });

  test("rejects protocol-relative and backslash host forms", () => {
    expect(safeRedirectTarget("//evil.example")).toBe("/");
    expect(safeRedirectTarget("/\\evil.example")).toBe("/");
  });

  test("rejects a bare relative path that could escape the route tree", () => {
    expect(safeRedirectTarget("gis")).toBe("/");
    expect(safeRedirectTarget("../admin")).toBe("/");
  });

  test("honours an explicit fallback", () => {
    expect(safeRedirectTarget("//evil.example", "/login")).toBe("/login");
  });
});
