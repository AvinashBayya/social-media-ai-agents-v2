import { describe, expect, test } from "bun:test";
import { parseLocalNetwork, scanWifiNetworks, getConnectedWifiInfo } from "../src/utils/local-network";

/**
 * These are real, unmocked integration tests against this machine's actual
 * Windows Wi-Fi stack (`netsh`) — no fixture, no mock. That means the real,
 * honest answer depends on this machine's real state: connected to Wi-Fi or
 * not, any networks in range or none, non-Windows or Windows. Assertions
 * below check SHAPE and internal consistency, never assume a specific
 * environment — a prior version of this file asserted `not.toBeNull()` /
 * `length > 0` unconditionally, which only ever passed because the dev
 * machine it was written on happened to be Wi-Fi-connected; those same
 * assertions previously passed everywhere only because local-network.ts
 * fabricated a fallback network/device list on any failure — removed for
 * exactly that reason (see local-network.ts's own header).
 *
 * Longer per-test timeouts than bun's 5000ms default: `scanWifiNetworks` now
 * performs a real, forced WinRT `WiFiAdapter.ScanAsync()` (confirmed ~10s on
 * a real machine — see local-network.ts's header for why that's correct
 * behavior, not something to rush) rather than a near-instant `netsh` text
 * scrape.
 */
const WIFI_SCAN_TIMEOUT_MS = 25_000;

describe("Local Network & Wi-Fi Scanner Utility", () => {
  test(
    "getConnectedWifiInfo returns a real connection or an honest null — never a placeholder",
    async () => {
      const connected = await getConnectedWifiInfo();
      if (connected === null) return; // genuinely not connected, or not Windows — a real, valid outcome
      expect(connected.ssid.length).toBeGreaterThan(0);
      expect(connected.state).toBe("Connected");
      expect(typeof connected.signal).toBe("number");
    },
    WIFI_SCAN_TIMEOUT_MS,
  );

  test(
    "scanWifiNetworks returns whatever was actually found — possibly zero, never padded",
    async () => {
      const wifiList = await scanWifiNetworks();
      expect(Array.isArray(wifiList)).toBe(true);
      for (const net of wifiList) {
        expect(net.ssid.length).toBeGreaterThan(0);
        expect(typeof net.signal).toBe("number");
        expect(net.security.length).toBeGreaterThan(0);
      }
    },
    WIFI_SCAN_TIMEOUT_MS,
  );

  test(
    "parseLocalNetwork's shape is always correct, regardless of what this machine's real network looks like",
    async () => {
      const data = await parseLocalNetwork();
      expect(Array.isArray(data.interfaces)).toBe(true);
      expect(Array.isArray(data.neighbors)).toBe(true);
      expect(Array.isArray(data.wifiNetworks)).toBe(true);
      expect(data.connectedWifi === null || typeof data.connectedWifi === "object").toBe(true);
      expect(data.scannedAt).toBeDefined();
    },
    WIFI_SCAN_TIMEOUT_MS,
  );
});
