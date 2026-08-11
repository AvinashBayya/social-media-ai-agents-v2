import { describe, expect, test } from "bun:test";
import { classifyThreatText } from "../src/utils/threat-classifier";
import { detectFocalPoints } from "../src/utils/focal-point";

describe("Multi-Domain Threat Classifier & Focal Point Engine", () => {
  test("classifyThreatText identifies military critical threat keywords", () => {
    const res = classifyThreatText("Urgent report: Airstrike confirmed on strategic airbase.");
    expect(res.primaryDomain).toBe("military");
    expect(res.severity).toBe("critical");
    expect(res.indicators).toContain("airstrike");
  });

  test("classifyThreatText identifies cyber threat indicators", () => {
    const res = classifyThreatText("Alert: Active C2 server host identified with exfiltration payloads.");
    expect(res.primaryDomain).toBe("cyber");
    expect(res.severity).toBe("high");
    expect(res.indicators).toContain("c2 server");
  });

  test("classifyThreatText falls back gracefully for neutral text", () => {
    const res = classifyThreatText("Scheduled quarterly meeting completed successfully.");
    expect(res.severity).toBe("low");
  });

  test("detectFocalPoints clusters events within spatio-temporal threshold", () => {
    const now = new Date().toISOString();
    const events = [
      { id: "e1", lat: 32.0, lon: 35.0, timestamp: now, title: "Event 1", source: "USGS" },
      { id: "e2", lat: 32.05, lon: 35.05, timestamp: now, title: "Event 2", source: "News" },
      { id: "e3", lat: 50.0, lon: 10.0, timestamp: now, title: "Distant Event", source: "GDELT" },
    ];

    const clusters = detectFocalPoints(events, 100, 24);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].eventCount).toBe(2);
  });
});
