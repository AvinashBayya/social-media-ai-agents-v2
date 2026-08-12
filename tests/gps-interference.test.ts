import { describe, expect, test } from "bun:test";
import {
  classifyGpsRegion,
  groupGpsHexesByRegion,
  type GpsJamData,
} from "../src/utils/gps-interference";
import { toGpsJamFinding } from "../src/types/core-adapters";

describe("GPS Interference & Jamming Module", () => {
  test("classifyGpsRegion correctly assigns regions based on coordinates", () => {
    expect(classifyGpsRegion(32.0, 35.5)).toBe("israel-sinai");
    expect(classifyGpsRegion(50.0, 30.0)).toBe("ukraine-russia");
    expect(classifyGpsRegion(33.0, 44.0)).toBe("iran-iraq");
    expect(classifyGpsRegion(0.0, 0.0)).toBe("other");
  });

  test("groupGpsHexesByRegion groups hexes into regional buckets", () => {
    const mockData: GpsJamData = {
      fetchedAt: new Date().toISOString(),
      source: "Test Source",
      stats: { totalHexes: 2, highCount: 1, mediumCount: 1 },
      hexes: [
        {
          h3: "8828308281fffff",
          lat: 32.0,
          lon: 35.5,
          level: "high",
          pct: 45.5,
          affectedAircraft: 10,
          totalAircraft: 22,
        },
        {
          h3: "8828308283fffff",
          lat: 50.0,
          lon: 30.0,
          level: "medium",
          pct: 15.0,
          affectedAircraft: 3,
          totalAircraft: 20,
        },
      ],
    };

    const grouped = groupGpsHexesByRegion(mockData);
    expect(grouped["israel-sinai"]).toHaveLength(1);
    expect(grouped["ukraine-russia"]).toHaveLength(1);
  });

  test("toGpsJamFinding adapts hex data into core finding structure", () => {
    const finding = toGpsJamFinding({
      h3: "8828308281fffff",
      lat: 32.0,
      lon: 35.5,
      level: "high",
      pct: 45.5,
      affectedAircraft: 10,
      totalAircraft: 22,
    });

    expect(finding.id).toBe("gpsjam-8828308281fffff");
    expect(finding.severity).toBe("high");
    expect(finding.lat).toBe(32.0);
    expect(finding.lon).toBe(35.5);
  });
});
