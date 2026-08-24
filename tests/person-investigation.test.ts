import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetAuditStoreForTests,
  assertLawfulBasis,
  buildSeedEntities,
  classifyFact,
  LawfulBasisError,
  personInvestigationEnabled,
  readPersonInvestigationAudit,
  startPersonInvestigation,
  validateSeeds,
  type StartPersonInvestigationInput,
} from "../src/utils/osint/person-investigation";

const validInput: StartPersonInvestigationInput = {
  investigator: "A. Analyst",
  caseRef: "INV-1001",
  lawfulBasisAttestation: "Authorized counter-fraud investigation, case INV-1001.",
  seeds: { personName: "John Smith" },
};

describe("personInvestigationEnabled — feature flag defaults off", () => {
  const original = process.env.PERSON_INVESTIGATION_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.PERSON_INVESTIGATION_ENABLED;
    else process.env.PERSON_INVESTIGATION_ENABLED = original;
  });

  test("unset env var means the feature is off", () => {
    delete process.env.PERSON_INVESTIGATION_ENABLED;
    expect(personInvestigationEnabled()).toBe(false);
  });

  test("any value other than the literal string 'true' stays off", () => {
    process.env.PERSON_INVESTIGATION_ENABLED = "1";
    expect(personInvestigationEnabled()).toBe(false);
  });

  test("PERSON_INVESTIGATION_ENABLED=true turns it on", () => {
    process.env.PERSON_INVESTIGATION_ENABLED = "true";
    expect(personInvestigationEnabled()).toBe(true);
  });
});

describe("assertLawfulBasis — the mandatory gate", () => {
  test("passes for fully-populated input", () => {
    expect(() => assertLawfulBasis(validInput)).not.toThrow();
  });

  test("rejects a missing case reference, naming the exact field", () => {
    try {
      assertLawfulBasis({ ...validInput, caseRef: "" });
      throw new Error("expected assertLawfulBasis to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LawfulBasisError);
      expect((err as LawfulBasisError).field).toBe("caseRef");
    }
  });

  test("rejects a whitespace-only case reference the same as an empty one", () => {
    expect(() => assertLawfulBasis({ ...validInput, caseRef: "   " })).toThrow(LawfulBasisError);
  });

  test("rejects a missing lawful-basis attestation, naming the exact field", () => {
    try {
      assertLawfulBasis({ ...validInput, lawfulBasisAttestation: "" });
      throw new Error("expected assertLawfulBasis to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LawfulBasisError);
      expect((err as LawfulBasisError).field).toBe("lawfulBasisAttestation");
    }
  });

  test("rejects a missing investigator name, naming the exact field", () => {
    try {
      assertLawfulBasis({ ...validInput, investigator: "" });
      throw new Error("expected assertLawfulBasis to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LawfulBasisError);
      expect((err as LawfulBasisError).field).toBe("investigator");
    }
  });
});

describe("validateSeeds", () => {
  test("requires a person name", () => {
    expect(validateSeeds({ personName: "" })).not.toBeNull();
    expect(validateSeeds({ personName: "  " })).not.toBeNull();
  });

  test("a real name alone is sufficient — every other field is optional", () => {
    expect(validateSeeds({ personName: "John Smith" })).toBeNull();
  });
});

describe("buildSeedEntities", () => {
  test("always produces the person entity, and only that, when no optional fields are given", () => {
    const entities = buildSeedEntities({ personName: "John Smith" });
    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({ type: "person", value: "John Smith", source: "analyst-seed" });
  });

  test("produces one entity per populated optional field, correctly typed", () => {
    const entities = buildSeedEntities({
      personName: "Jane Doe",
      publicEmail: "jane@example.com",
      username: "janedoe",
      publicPhone: "+1 555 0100",
      domain: "example.com",
      organization: "Example Corp",
    });
    expect(entities).toHaveLength(6);
    const types = entities.map((e) => e.type).sort();
    expect(types).toEqual(["domain", "email", "organization", "person", "phone", "username"].sort());
  });

  test("blank optional fields are skipped, not turned into empty entities", () => {
    const entities = buildSeedEntities({ personName: "John Smith", publicEmail: "  ", username: undefined });
    expect(entities).toHaveLength(1);
  });

  test("seed confidence is null with a real reason, never UNSCORED's bare empty-reasons shape", () => {
    const [person] = buildSeedEntities({ personName: "John Smith" });
    expect(person.confidence.value).toBeNull();
    expect(person.confidence.reasons.length).toBeGreaterThan(0);
  });

  test("seed entity ids are stable and collision-free across the produced set", () => {
    const entities = buildSeedEntities({
      personName: "John Smith",
      publicEmail: "john@example.com",
      username: "john",
    });
    const ids = entities.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("classifyFact — Confirmed / Possible / Unknown", () => {
  test("a null-value confidence (no corroboration) classifies as Unknown", () => {
    expect(classifyFact({ value: null, reasons: [] })).toBe("Unknown");
  });

  test("a single independently-corroborated source (entity-resolution's 2-source 0.65) classifies as Possible", () => {
    expect(classifyFact({ value: 0.65, reasons: ["same normalized email reported by 2 independent collectors"] })).toBe(
      "Possible",
    );
  });

  test("three or more corroborating sources (entity-resolution's 0.8+) classifies as Confirmed", () => {
    expect(classifyFact({ value: 0.8, reasons: [] })).toBe("Confirmed");
  });

  test("the boundary is inclusive at the documented threshold", () => {
    expect(classifyFact({ value: 0.75, reasons: [] })).toBe("Confirmed");
    expect(classifyFact({ value: 0.74, reasons: [] })).toBe("Possible");
  });
});

describe("startPersonInvestigation — end to end, including the audit log write", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sentinel-person-investigation-test-"));
    process.env.PERSON_AUDIT_LOG_PATH = join(dir, "audit.sqlite");
    __resetAuditStoreForTests();
  });

  afterEach(() => {
    __resetAuditStoreForTests();
    delete process.env.PERSON_AUDIT_LOG_PATH;
    rmSync(dir, { recursive: true, force: true });
  });

  test("throws LawfulBasisError and writes nothing when the gate fails", async () => {
    await expect(
      startPersonInvestigation({ ...validInput, caseRef: "" }, ["presence.news"]),
    ).rejects.toThrow(LawfulBasisError);
    expect(await readPersonInvestigationAudit()).toEqual([]);
  });

  test("a valid start returns and persists exactly the required audit fields", async () => {
    const entry = await startPersonInvestigation(validInput, ["presence.news", "contact.domain"]);
    expect(entry.investigator).toBe("A. Analyst");
    expect(entry.caseRef).toBe("INV-1001");
    expect(entry.subjectSeeds).toEqual(validInput.seeds);
    expect(entry.sources).toEqual(["presence.news", "contact.domain"]);
    expect(typeof entry.startedAt).toBe("string");
    expect(new Date(entry.startedAt).toISOString()).toBe(entry.startedAt);

    const persisted = await readPersonInvestigationAudit();
    expect(persisted).toEqual([entry]);
  });

  test("startedAt reflects the real moment of the call, not a fabricated/reused timestamp", async () => {
    const before = Date.now();
    const entry = await startPersonInvestigation(validInput, []);
    const after = Date.now();
    const ts = new Date(entry.startedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  test("multiple starts for the same case both persist and are retrievable by case reference", async () => {
    await startPersonInvestigation(validInput, ["presence.news"]);
    await startPersonInvestigation(validInput, ["contact.domain"]);
    expect(await readPersonInvestigationAudit("INV-1001")).toHaveLength(2);
  });
});
