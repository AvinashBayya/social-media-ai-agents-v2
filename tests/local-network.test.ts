import { describe, expect, test } from "bun:test";
import { parseLocalNetwork, scanWifiNetworks, getConnectedWifiInfo } from "../src/utils/local-network";

describe("Local Network & Wi-Fi Scanner Utility", () => {
  test("getConnectedWifiInfo returns host active Wi-Fi interface details", async () => {
    const connected = await getConnectedWifiInfo();
    expect(connected).not.toBeNull();
    expect(connected?.ssid).toBeDefined();
    expect(connected?.bssid).toBeDefined();
    expect(connected?.state).toBe("Connected");
  });

  test("scanWifiNetworks returns structured Wi-Fi network records", async () => {
    const wifiList = await scanWifiNetworks();
    expect(wifiList.length).toBeGreaterThan(0);

    const first = wifiList[0];
    expect(first.ssid).toBeDefined();
    expect(typeof first.signal).toBe("number");
    expect(first.security).toBeDefined();
    expect(first.channel).toBeDefined();
  });

  test("parseLocalNetwork includes interfaces, neighbors, connectedWifi and wifiNetworks", async () => {
    const data = await parseLocalNetwork();
    expect(Array.isArray(data.interfaces)).toBe(true);
    expect(Array.isArray(data.neighbors)).toBe(true);
    expect(Array.isArray(data.wifiNetworks)).toBe(true);
    expect(data.connectedWifi).toBeDefined();
    expect(data.wifiNetworks.length).toBeGreaterThan(0);
    expect(data.scannedAt).toBeDefined();
  });
});
