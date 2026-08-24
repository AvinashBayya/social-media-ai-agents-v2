import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersonAuditStore } from "../src/utils/osint/person-audit-store";
import type { PersonInvestigationAuditEntry } from "../src/utils/osint/person-investigation";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sentinel-person-audit-test-"));
  dbPath = join(dir, "audit.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const entry = (overrides: Partial<PersonInvestigationAuditEntry> = {}): PersonInvestigationAuditEntry => ({
  investigator: "A. Analyst",
  caseRef: "INV-1001",
  subjectSeeds: { personName: "John Smith", email: "john@example.com" },
  startedAt: "2026-08-19T10:00:00.000Z",
  sources: ["presence.news", "contact.domain"],
  ...overrides,
});

describe("PersonAuditStore — append-only round trip", () => {
  test("append then readAll returns the same entry", () => {
    const store = new PersonAuditStore(dbPath);
    store.append(entry());
    expect(store.readAll()).toEqual([entry()]);
    store.close();
  });

  test("readAll with no entries returns an empty array, not undefined or null", () => {
    const store = new PersonAuditStore(dbPath);
    expect(store.readAll()).toEqual([]);
    store.close();
  });

  test("multiple appends preserve order (oldest first)", () => {
    const store = new PersonAuditStore(dbPath);
    store.append(entry({ caseRef: "INV-1001", startedAt: "2026-08-19T10:00:00.000Z" }));
    store.append(entry({ caseRef: "INV-1002", startedAt: "2026-08-19T10:05:00.000Z" }));
    const all = store.readAll();
    expect(all.map((e) => e.caseRef)).toEqual(["INV-1001", "INV-1002"]);
    store.close();
  });

  test("readForCase filters to only the given case reference", () => {
    const store = new PersonAuditStore(dbPath);
    store.append(entry({ caseRef: "INV-1001" }));
    store.append(entry({ caseRef: "INV-1002" }));
    store.append(entry({ caseRef: "INV-1001" }));
    expect(store.readForCase("INV-1001")).toHaveLength(2);
    expect(store.readForCase("INV-9999")).toEqual([]);
    store.close();
  });

  test("survives being closed and reopened at the same path — proves durability, not just in-process caching", () => {
    const first = new PersonAuditStore(dbPath);
    first.append(entry());
    first.close();

    const second = new PersonAuditStore(dbPath);
    expect(second.readAll()).toEqual([entry()]);
    second.close();
  });

  test("subjectSeeds round-trips every field, including optional ones", () => {
    const store = new PersonAuditStore(dbPath);
    const rich = entry({
      subjectSeeds: {
        personName: "Jane Doe",
        email: "jane@example.com",
        username: "janedoe",
        phone: "+1 555 0100",
        domain: "example.com",
        organization: "Example Corp",
      },
    });
    store.append(rich);
    expect(store.readAll()[0].subjectSeeds).toEqual(rich.subjectSeeds);
    store.close();
  });

  test("appended lines are real JSON Lines on disk — one JSON object per line, human-inspectable", () => {
    const store = new PersonAuditStore(dbPath);
    store.append(entry({ caseRef: "INV-1001" }));
    store.append(entry({ caseRef: "INV-1002" }));
    const raw = readFileSync(dbPath, "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).caseRef).toBe("INV-1001");
    expect(JSON.parse(lines[1]).caseRef).toBe("INV-1002");
    store.close();
  });
});
