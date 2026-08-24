/**
 * The refusal tests come first, and one of them is the most important test in
 * this file: `execute()` must make NO network call at all for an unauthorised
 * target. A gate that refuses only after scanning has not refused anything.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { ivreCollector, parseIvreHosts, parseIvrePorts, readScanAuthorisations } from "../src/utils/collectors/external/ivre";
import type { IvreRaw } from "../src/utils/collectors/external/ivre";
import type { CollectorRunOutcome } from "../src/utils/collectors/types";

const originalFetch = globalThis.fetch;
const originalUrl = process.env.IVRE_URL;
const originalAuth = process.env.SCAN_AUTHORISATIONS;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.IVRE_URL;
  else process.env.IVRE_URL = originalUrl;
  if (originalAuth === undefined) delete process.env.SCAN_AUTHORISATIONS;
  else process.env.SCAN_AUTHORISATIONS = originalAuth;
});

/** Far-future expiry so these tests do not rot. */
const LIVE_AUTH = JSON.stringify([
  {
    target: "example.com",
    scope: "active",
    authorisedBy: "Wg Cdr A. Sharma",
    reference: "IAF/PS18/AUTH/2026/014",
    grantedAt: "2026-08-01T00:00:00Z",
    expiresAt: "2099-01-01T00:00:00Z",
  },
]);

function stubFetch(make: () => Response | Promise<Response>) {
  globalThis.fetch = (async () => make()) as typeof fetch;
}

function failFetch() {
  globalThis.fetch = (() => {
    throw new Error("NETWORK CALLED — the gate did not stop this");
  }) as unknown as typeof fetch;
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function completedOutcome(raw: IvreRaw): CollectorRunOutcome<IvreRaw> {
  return {
    execution: {
      status: "completed",
      startedAt: "2026-08-17T00:00:00.000Z",
      completedAt: "2026-08-17T00:00:01.000Z",
      durationMs: 1000,
      resultCount: 1,
      error: null,
    },
    raw,
  };
}

describe("the gate refuses before the network", () => {
  test("an unauthorised target makes NO request", async () => {
    process.env.IVRE_URL = "http://localhost:5000";
    delete process.env.SCAN_AUTHORISATIONS;
    failFetch(); // any fetch here fails the test loudly

    const outcome = await ivreCollector.execute({ type: "domain", value: "example.com" });
    expect(outcome.raw).toBeNull();
    expect(outcome.execution.status).toBe("failed");
    expect(outcome.execution.error?.message).toContain("no written authorisation covers");
  });

  test("an expired authorisation refuses, and names expiry as the cause", async () => {
    process.env.IVRE_URL = "http://localhost:5000";
    process.env.SCAN_AUTHORISATIONS = JSON.stringify([
      {
        target: "example.com",
        scope: "active",
        authorisedBy: "Wg Cdr A. Sharma",
        reference: "R1",
        grantedAt: "2020-01-01T00:00:00Z",
        expiresAt: "2020-02-01T00:00:00Z",
      },
    ]);
    failFetch();
    const outcome = await ivreCollector.execute({ type: "domain", value: "example.com" });
    expect(outcome.execution.error?.message).toContain("expired");
  });

  test("a passive-scope authorisation does not permit an active read", async () => {
    process.env.IVRE_URL = "http://localhost:5000";
    process.env.SCAN_AUTHORISATIONS = JSON.stringify([
      {
        target: "example.com",
        scope: "passive",
        authorisedBy: "Wg Cdr A. Sharma",
        reference: "R1",
        grantedAt: "2026-08-01T00:00:00Z",
        expiresAt: "2099-01-01T00:00:00Z",
      },
    ]);
    failFetch();
    const outcome = await ivreCollector.execute({ type: "domain", value: "example.com" });
    expect(outcome.execution.error?.message).toContain("passive-scope");
  });

  test("a neighbouring domain is not covered by the suffix", async () => {
    process.env.IVRE_URL = "http://localhost:5000";
    process.env.SCAN_AUTHORISATIONS = LIVE_AUTH;
    failFetch();
    const outcome = await ivreCollector.execute({ type: "domain", value: "notexample.com" });
    expect(outcome.execution.error?.message).toContain("no written authorisation covers");
  });

  test("link-local metadata is refused even under a 0.0.0.0/0 authorisation", async () => {
    process.env.IVRE_URL = "http://localhost:5000";
    process.env.SCAN_AUTHORISATIONS = JSON.stringify([
      {
        target: "0.0.0.0/0",
        scope: "active",
        authorisedBy: "Wg Cdr A. Sharma",
        reference: "R1",
        grantedAt: "2026-08-01T00:00:00Z",
        expiresAt: "2099-01-01T00:00:00Z",
      },
    ]);
    failFetch();
    const outcome = await ivreCollector.execute({ type: "ip", value: "169.254.169.254" });
    expect(outcome.execution.error?.message).toContain("private, loopback, link-local");
  });

  test("IVRE_URL unset reports unavailable", async () => {
    delete process.env.IVRE_URL;
    process.env.SCAN_AUTHORISATIONS = LIVE_AUTH;
    const outcome = await ivreCollector.execute({ type: "domain", value: "example.com" });
    expect(outcome.execution.error?.reason).toBe("unavailable");
  });
});

describe("malformed authorisation config never widens permission", () => {
  test("invalid JSON yields no authorisations", () => {
    expect(readScanAuthorisations({ SCAN_AUTHORISATIONS: "{not json" }, () => {})).toEqual([]);
  });

  test("a JSON object rather than an array yields none", () => {
    expect(readScanAuthorisations({ SCAN_AUTHORISATIONS: '{"target":"x"}' }, () => {})).toEqual([]);
  });

  test("records missing required fields are dropped", () => {
    const records = readScanAuthorisations(
      {
        SCAN_AUTHORISATIONS: JSON.stringify([
          { target: "a.com", scope: "active", authorisedBy: "X" }, // no reference/expiry
          {
            target: "b.com",
            scope: "active",
            authorisedBy: "X",
            reference: "R",
            grantedAt: "2026-01-01T00:00:00Z",
            expiresAt: "2099-01-01T00:00:00Z",
          },
        ]),
      },
      () => {},
    );
    expect(records).toHaveLength(1);
    expect(records[0].target).toBe("b.com");
  });

  test("an unset variable authorises nothing", () => {
    expect(readScanAuthorisations({}, () => {})).toEqual([]);
  });
});

describe("an authorised read proceeds and is audited", () => {
  test("returns hosts and carries the authorisation on the result", async () => {
    process.env.IVRE_URL = "http://localhost:5000";
    process.env.SCAN_AUTHORISATIONS = LIVE_AUTH;
    stubFetch(() =>
      jsonRes([
        {
          addr: "93.184.216.34",
          hostnames: [{ name: "example.com" }],
          endtime: "2026-08-10T10:00:00Z",
          ports: [
            { port: 443, protocol: "tcp", state_state: "open", service_name: "https" },
          ],
        },
      ]),
    );
    const outcome = await ivreCollector.execute({ type: "domain", value: "example.com" });
    expect(outcome.execution.status).toBe("completed");
    expect(outcome.raw?.hosts).toHaveLength(1);
    expect(outcome.raw?.audit.reference).toBe("IAF/PS18/AUTH/2026/014");
    expect(outcome.raw?.audit.authorisedBy).toBe("Wg Cdr A. Sharma");
  });
});

describe("parsing", () => {
  test("a port outside 0-65535 is dropped rather than emitted", () => {
    expect(parseIvrePorts([{ port: 70000 }, { port: 22 }])).toHaveLength(1);
  });

  test("an unreported service is null, never a guessed name", () => {
    const ports = parseIvrePorts([{ port: 22, protocol: "tcp", state_state: "open" }]);
    expect(ports[0].service).toBeNull();
    expect(ports[0].product).toBeNull();
  });

  test("a host with no scan timestamp keeps lastSeen null, not collection time", () => {
    const hosts = parseIvreHosts([{ addr: "1.2.3.4", ports: [] }]);
    expect(hosts[0].lastSeen).toBeNull();
  });

  test("a record with no address is dropped", () => {
    expect(parseIvreHosts([{ ports: [] }, { addr: "1.2.3.4" }])).toHaveLength(1);
  });
});

describe("normalisation frames findings as unverified", () => {
  const raw: IvreRaw = {
    target: "example.com",
    hosts: [
      {
        addr: "93.184.216.34",
        hostnames: ["example.com"],
        lastSeen: "2026-08-10T10:00:00Z",
        ports: [
          { port: 443, protocol: "tcp", state: "open", service: "https", product: null },
        ],
      },
    ],
    audit: {
      target: "example.com",
      scope: "active",
      authorisedBy: "Wg Cdr A. Sharma",
      reference: "IAF/PS18/AUTH/2026/014",
      at: "2026-08-17T00:00:00.000Z",
      collector: "ivre",
    },
  };

  test("always warns that banners are self-reported and possibly stale", () => {
    const result = ivreCollector.normalize(completedOutcome(raw));
    expect(result.warnings.join(" ")).toContain("unverified candidate for analyst review");
    expect(result.warnings.join(" ")).toContain("trivially forged");
  });

  test("evidence carries the authorisation provenance", () => {
    const result = ivreCollector.normalize(completedOutcome(raw));
    expect(result.evidence[0].metadata).toMatchObject({
      authorisationReference: "IAF/PS18/AUTH/2026/014",
      authorisedBy: "Wg Cdr A. Sharma",
    });
  });

  test("no scan record is an absence of DATA, not an absence of open ports", () => {
    const result = ivreCollector.normalize(completedOutcome({ ...raw, hosts: [] }));
    expect(result.warnings.join(" ")).toContain("absence of DATA");
  });

  test("hostname resolution is not claimed as independently verified", () => {
    const result = ivreCollector.normalize(completedOutcome(raw));
    const edge = result.relationships.find((r) => r.relationshipType === "RESOLVES_TO");
    expect(edge?.confidence.value).toBeNull();
    expect(edge?.confidence.reasons.join(" ")).toContain("not independently re-resolved");
  });
});
