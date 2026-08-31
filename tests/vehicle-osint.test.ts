import { describe, expect, test } from "bun:test";
import { isVin, isRegistrationPlate, lookupVehicleIntelligence } from "../src/utils/vehicle-osint";

describe("Vehicle OSINT & VIN Collector", () => {
  test("isVin identifies valid 17-character VINs", () => {
    expect(isVin("1HGCR2F83HA000000")).toBe(true);
    expect(isVin("JM1FE173400100000")).toBe(true);
    expect(isVin("SHORT123")).toBe(false);
  });

  test("isRegistrationPlate identifies Indian RTO formats", () => {
    expect(isRegistrationPlate("MH12DE1432")).toBe(true);
    expect(isRegistrationPlate("KA01MJ9999")).toBe(true);
    expect(isRegistrationPlate("DL3CCE1234")).toBe(true);
    expect(isRegistrationPlate("TG09G0666")).toBe(true);
    expect(isRegistrationPlate("TS07AB1234")).toBe(true);
  });

  test("lookupVehicleIntelligence decodes TG09G0666 as Khairatabad, Hyderabad Central RTO in Telangana", async () => {
    const res = await lookupVehicleIntelligence("TG 09 G 0666");
    expect(res.target).toBe("TG09G0666");
    expect(res.type).toBe("registration_plate");
    expect(res.stateOrRegion).toBe("Telangana");
    expect(res.rtoLocation).toContain("Khairatabad, Hyderabad Central RTO");
    expect(res.officialPortalUrl).toBe("https://transport.telangana.gov.in/");
  });

  test("lookupVehicleIntelligence parses RTO state & location for registration plates", async () => {
    const res = await lookupVehicleIntelligence("MH12DE1432");
    expect(res.target).toBe("MH12DE1432");
    expect(res.type).toBe("registration_plate");
    expect(res.stateOrRegion).toBe("Maharashtra");
    expect(res.rtoLocation).toContain("Pune");
  });

  test("lookupVehicleIntelligence decodes Koramangala RTO for KA01 plate", async () => {
    const res = await lookupVehicleIntelligence("KA01MJ9999");
    expect(res.target).toBe("KA01MJ9999");
    expect(res.stateOrRegion).toBe("Karnataka");
    expect(res.rtoLocation).toContain("Koramangala");
  });

  test("lookupVehicleIntelligence handles empty input with error", async () => {
    expect(lookupVehicleIntelligence("")).rejects.toThrow("Vehicle registration number or VIN is required");
  });
});
