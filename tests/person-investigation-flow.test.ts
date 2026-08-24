import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  buildSeedEntities,
  validateSeeds,
  classifyFact,
  assertLawfulBasis,
  extractDiscoveredDomains,
  __resetAuditStoreForTests,
  type PersonInvestigationSeeds,
  type StartPersonInvestigationInput,
} from "../src/utils/osint/person-investigation";
import { generatePersonSearchQueries } from "../src/utils/osint/person-query-planner";

describe("Person Investigation Pipeline & Target Models", () => {
  beforeEach(() => {
    __resetAuditStoreForTests();
  });

  afterEach(() => {
    __resetAuditStoreForTests();
  });

  test("validateSeeds rejects missing or empty person name", () => {
    expect(validateSeeds({ personName: "" })).toContain("person name is required");
    expect(validateSeeds({ personName: "   " })).toContain("person name is required");
    expect(validateSeeds({ personName: "John Smith" })).toBeNull();
  });

  test("buildSeedEntities creates correctly typed CollectorEntity array for all target parameters", () => {
    const seeds: PersonInvestigationSeeds = {
      personName: "John Smith",
      aliases: ["Johnny", "J. Smith"],
      age: 35,
      dateOfBirth: "1991-05-12",
      city: "Hyderabad",
      state: "Telangana",
      country: "India",
      designation: "Chief Technology Officer",
      organization: "Acme Cyber",
      publicEmail: "john@acme.com",
      publicPhone: "+1-555-0199",
      username: "johnsmith_dev",
      knownSocialProfiles: ["https://x.com/johnsmith"],
      website: "https://johnsmith.dev",
      domain: "acme.com",
    };

    const entities = buildSeedEntities(seeds);
    expect(entities.length).toBeGreaterThan(5);

    const personEntity = entities.find((e) => e.type === "person" && e.value === "John Smith");
    expect(personEntity).toBeDefined();
    expect(personEntity?.metadata.age).toBe(35);
    expect(personEntity?.metadata.dateOfBirth).toBe("1991-05-12");

    const emailEntity = entities.find((e) => e.type === "email");
    expect(emailEntity?.value).toBe("john@acme.com");

    const phoneEntity = entities.find((e) => e.type === "phone");
    expect(phoneEntity?.value).toBe("+1-555-0199");

    const orgEntity = entities.find((e) => e.type === "organization");
    expect(orgEntity?.value).toBe("Acme Cyber");
  });

  test("assertLawfulBasis enforces mandatory governance fields", () => {
    const input: StartPersonInvestigationInput = {
      investigator: "Analyst 007",
      caseRef: "INV-2026-001",
      lawfulBasisAttestation: "Authorized OSINT Security Audit",
      seeds: { personName: "John Smith" },
    };

    expect(() => assertLawfulBasis(input)).not.toThrow();

    try {
      assertLawfulBasis({ ...input, caseRef: "" });
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.field).toBe("caseRef");
    }

    try {
      assertLawfulBasis({ ...input, lawfulBasisAttestation: "" });
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.field).toBe("lawfulBasisAttestation");
    }

    try {
      assertLawfulBasis({ ...input, investigator: "" });
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.field).toBe("investigator");
    }
  });

  test("classifyFact correctly labels confidence scores into Confirmed, Possible, Unknown", () => {
    expect(classifyFact({ value: null, reasons: [] })).toBe("Unknown");
    expect(classifyFact({ value: 0.5, reasons: ["Single source"] })).toBe("Possible");
    expect(classifyFact({ value: 0.65, reasons: ["2 sources"] })).toBe("Possible");
    expect(classifyFact({ value: 0.8, reasons: ["3 sources"] })).toBe("Confirmed");
    expect(classifyFact({ value: 0.95, reasons: ["4+ sources"] })).toBe("Confirmed");
  });

  test("generatePersonSearchQueries generates targeted dorks from target inputs", () => {
    const seeds: PersonInvestigationSeeds = {
      personName: "Alice Zhang",
      city: "San Francisco",
      organization: "TechCorp",
      designation: "VP Engineering",
      domain: "techcorp.com",
    };

    const queries = generatePersonSearchQueries(seeds);
    expect(queries.length).toBeGreaterThanOrEqual(4);

    const nameQuery = queries.find((q) => q.title === "Full Name Search");
    expect(nameQuery?.query).toBe('"Alice Zhang"');

    const locationQuery = queries.find((q) => q.title === "Name + Location");
    expect(locationQuery?.query).toBe('"Alice Zhang" "San Francisco"');

    const orgQuery = queries.find((q) => q.title === "Name + Organization");
    expect(orgQuery?.query).toBe('"Alice Zhang" "TechCorp"');

    const pdfQuery = queries.find((q) => q.title === "Public PDF Documents");
    expect(pdfQuery?.query).toBe('"Alice Zhang" filetype:pdf');

    const domainQuery = queries.find((q) => q.title === "Domain Targeted Search");
    expect(domainQuery?.query).toBe('site:techcorp.com "Alice Zhang"');
  });

  test("extractDiscoveredDomains extracts clean domains for secondary enrichment", () => {
    const entities = [
      { id: "e1", type: "domain" as const, value: "https://sub.example.com/path", displayName: "example.com", source: "test", confidence: { value: 1, reasons: [] }, metadata: {} },
      { id: "e2", type: "domain" as const, value: "www.acme.org", displayName: "acme.org", source: "test", confidence: { value: 1, reasons: [] }, metadata: {} },
      { id: "e3", type: "person" as const, value: "John", displayName: "John", source: "test", confidence: { value: 1, reasons: [] }, metadata: {} },
    ];

    const domains = extractDiscoveredDomains(entities);
    expect(domains).toContain("sub.example.com");
    expect(domains).toContain("acme.org");
    expect(domains).not.toContain("John");
  });

  test("presence.image, presence.username, social, identity.websearch execute cleanly (image is deliberately, permanently unavailable — see its own test file)", async () => {
    const { presenceImageCollector } = await import("../src/utils/collectors/person/presence-image");
    const { presenceUsernameCollector } = await import("../src/utils/collectors/person/presence-username");
    const { identityWebsearchCollector } = await import("../src/utils/collectors/person/identity-websearch");
    const { socialCollector } = await import("../src/utils/collectors/existing/social");

    // presence.image never "completes" — it always reports unavailable, by
    // deliberate design (no face-matching capability exists in this system;
    // see collectors-person-presence-image.test.ts and the file's own header
    // comment). "Executes cleanly" here means a well-formed failed outcome,
    // not a thrown exception.
    const imgOutcome = await presenceImageCollector.execute({ type: "person", value: "Sourav Das" });
    expect(imgOutcome.execution.status).toBe("failed");
    expect(imgOutcome.execution.error?.reason).toBe("unavailable");

    const usrOutcome = await presenceUsernameCollector.execute({ type: "username", value: "souravdas" });
    expect(usrOutcome.execution.status).toBe("completed");

    const webOutcome = await identityWebsearchCollector.execute({ type: "person", value: "Sourav Das" });
    expect(webOutcome.execution.status).toBe("completed");

    const socOutcome = await socialCollector.execute({ type: "person", value: "Sourav Das" });
    expect(socOutcome.execution.status).toBe("completed");
  }, 15000);
});
