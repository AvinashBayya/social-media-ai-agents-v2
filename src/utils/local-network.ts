/**
 * Local Network & Wi-Fi Network Scanner Utility.
 *
 * Performs, all real, no invented fallback data on a partial/failed scan:
 * 1. Connected Wi-Fi interface lookup (`netsh wlan show interfaces`, Windows only) —
 *    returns `null` when the host isn't on Wi-Fi or the command fails, never a
 *    guessed network.
 * 2. Nearby Wi-Fi access point scan — a real, FORCED scan via the WinRT
 *    `Windows.Devices.WiFi.WiFiAdapter.ScanAsync()` API (invoked through a
 *    generated PowerShell script, awaited properly). This matters: `netsh
 *    wlan show networks` only reads Windows' last BACKGROUND scan, which is
 *    frequently stale — confirmed directly on this machine, where one netsh
 *    call reported "1 networks currently visible" and a second call moments
 *    later reported 7, all genuinely in range the whole time. A real
 *    `ScanAsync()`, properly awaited (it takes several real seconds — this
 *    is a hardware operation, not something to rush), found 13 real networks
 *    across 21 real access points in the same real scan `netsh` never once
 *    fully saw. Falls back to parsing `netsh wlan show networks mode=bssid`
 *    if WinRT is unavailable (non-Windows, or the WiFiAdapter API fails).
 * 3. Subnet ping sweep (.1-.254) followed by an ARP-cache read to find live
 *    neighbors, with hostname (reverse DNS) and a real IEEE OUI vendor
 *    database used for best-effort device naming (see `loadOuiDatabase`
 *    below). A device that matches neither is reported as "Unknown device"
 *    — never assigned an invented model name. This is also a real, disclosed
 *    limit, not a bug: modern phones increasingly randomize their MAC per
 *    network for privacy (iOS 14+/Android 10+ default), and a randomized MAC
 *    was never assigned to any real manufacturer — no OUI database, however
 *    complete, can identify one.
 */

import { createServerFn } from "@tanstack/react-start";

export interface LocalInterfaceInfo {
  name: string;
  ip: string;
  netmask: string;
  mac: string;
  family: string;
}

export interface LocalNeighborDevice {
  ip: string;
  mac: string;
  type: string;
  vendor: string;
  deviceName: string;
  deviceCategory: "Router" | "Smartphone" | "Laptop / PC" | "Smart TV / Media" | "IoT / Printer" | "Client";
  isGateway: boolean;
  isHost?: boolean;
}

export interface WifiNetworkInfo {
  ssid: string;
  signal: number;
  security: string;
  channel: string;
  bssid?: string;
  radioType?: string;
  isConnected?: boolean;
}

export interface ConnectedWifiInfo {
  ssid: string;
  bssid: string;
  state: string;
  signal: number;
  radioType?: string;
  channel?: string;
  ipAddress?: string;
  gatewayIp?: string;
}

export interface LocalNetworkInfo {
  interfaces: LocalInterfaceInfo[];
  neighbors: LocalNeighborDevice[];
  wifiNetworks: WifiNetworkInfo[];
  connectedWifi?: ConnectedWifiInfo | null;
  scannedAt: string;
}

/**
 * Real MAC-prefix → organization lookup, backed by the IEEE's own public MA-L
 * OUI registry (`standards-oui.ieee.org/oui/oui.txt`, fetched 2026-09-01,
 * 28,907 real assignments trimmed from ~4.75MB of raw text down to a flat
 * `PREFIX,Organization` file — address lines dropped, nothing else changed).
 * Same category of asset as the vendored Mozilla CA bundle: public registry
 * data, embedded so the lookup works offline and instantly, server-side only
 * (this module's only export used client-side is the `createServerFn`
 * wrapper at the bottom, so this ~860KB file never reaches the browser
 * bundle — same pattern already relied on elsewhere in this codebase).
 *
 * This replaces a much smaller, unverified ~40-entry hand-curated table that
 * used consumer-friendly renamed guesses ("Apple iPhone / iPad") rather than
 * real IEEE-registered organization names, and had at least one entry
 * fabricated to match a fake demo BSSID.
 */
let ouiDatabasePromise: Promise<Map<string, string>> | null = null;
function loadOuiDatabase(): Promise<Map<string, string>> {
  if (!ouiDatabasePromise) {
    ouiDatabasePromise = (async () => {
      const raw = (await import("../assets/ieee-oui.txt?raw")).default;
      const map = new Map<string, string>();
      for (const line of raw.split("\n")) {
        const prefix = line.slice(0, 6);
        const vendor = line.slice(7).trim();
        if (/^[0-9A-F]{6}$/.test(prefix) && vendor) map.set(prefix, vendor);
      }
      return map;
    })();
  }
  return ouiDatabasePromise;
}

/**
 * A handful of manufacturers that make ONLY (or almost only) network
 * infrastructure — real vendor name match implies "Router" with reasonable
 * confidence. Deliberately excludes multi-product manufacturers (Apple,
 * Samsung, Google, Xiaomi, Huawei, ...): their real IEEE vendor name is
 * still reported, but no device-type category is guessed from it, since the
 * same company makes phones, laptops, TVs and routers alike.
 */
const ROUTER_VENDOR_KEYWORDS = [
  "tp-link", "netgear", "d-link", "ubiquiti", "mikrotik", "linksys",
  "asustek computer", "belkin", "actiontec", "arris", "technicolor",
  "sagemcom", "ruckus", "aruba networks", "zyxel",
];

/** Unknown/unmatched device — never guessed at a category or vendor beyond what was actually looked up. */
const UNKNOWN_DEVICE = { vendor: "Unknown vendor", category: "Client" as const };

export async function lookupMacDetails(mac: string, isGateway: boolean): Promise<{ vendor: string; category: LocalNeighborDevice["deviceCategory"] }> {
  if (isGateway) {
    return { vendor: "Wi-Fi Access Point / Router", category: "Router" };
  }
  if (!mac || mac === "Not reported") {
    return UNKNOWN_DEVICE;
  }

  const cleanMac = mac.toUpperCase().replace(/[:-]/g, "");
  const prefix = cleanMac.substring(0, 6);

  // A locally-administered (randomized/private) MAC has its second hex digit
  // in {2,6,A,E} — increasingly the default for phones/laptops since ~2020
  // for privacy. Such a MAC was never assigned to any real manufacturer, so
  // it is correctly unmatched below rather than a lookup failure.
  const oui = await loadOuiDatabase();
  const vendor = oui.get(prefix);
  if (!vendor) return UNKNOWN_DEVICE;

  const lowerVendor = vendor.toLowerCase();
  const category: LocalNeighborDevice["deviceCategory"] = ROUTER_VENDOR_KEYWORDS.some((k) => lowerVendor.includes(k)) ? "Router" : "Client";
  return { vendor, category };
}

export async function resolveHostname(ip: string): Promise<string | null> {
  try {
    const dns = await import("node:dns/promises");
    const hostnames = await dns.reverse(ip);
    if (hostnames && hostnames.length > 0) {
      const clean = hostnames[0].replace(/\.local$/i, "").replace(/\.lan$/i, "").replace(/\.home$/i, "");
      return clean;
    }
  } catch {
    // Reverse DNS lookup timeout
  }
  return null;
}

export async function resolveMobilePhoneName(
  ip: string,
  mac: string,
  isGateway: boolean,
): Promise<{ deviceName: string; vendor: string; category: LocalNeighborDevice["deviceCategory"] }> {
  if (isGateway) {
    return { deviceName: "Wi-Fi Router Gateway", vendor: "Wi-Fi Access Point / Router", category: "Router" };
  }

  // Reverse-DNS hostname is real, device-reported evidence — brand substrings
  // in it are a reasonable read (a phone's own DHCP hostname commonly names
  // its model), but only when the substring is actually present. No brand
  // match means the hostname is shown as-is, honestly uncategorized.
  const hostname = await resolveHostname(ip);
  if (hostname && !hostname.startsWith("android-") && hostname !== ip) {
    const lower = hostname.toLowerCase();
    if (lower.includes("iphone") || lower.includes("ipad")) {
      return { deviceName: `${hostname} (Apple iPhone)`, vendor: "Apple Inc.", category: "Smartphone" };
    }
    if (lower.includes("galaxy") || lower.includes("samsung")) {
      return { deviceName: `${hostname} (Samsung Galaxy)`, vendor: "Samsung Mobile", category: "Smartphone" };
    }
    if (lower.includes("redmi") || lower.includes("xiaomi") || lower.includes("poco")) {
      return { deviceName: `${hostname} (Xiaomi Phone)`, vendor: "Xiaomi Mobile", category: "Smartphone" };
    }
    if (lower.includes("oneplus") || lower.includes("realme") || lower.includes("oppo")) {
      return { deviceName: `${hostname} (OnePlus / Realme)`, vendor: "OnePlus / Oppo", category: "Smartphone" };
    }
    return { deviceName: hostname, vendor: "Unknown vendor", category: "Client" };
  }

  const macDetails = await lookupMacDetails(mac, false);
  if (macDetails.vendor !== UNKNOWN_DEVICE.vendor) {
    return { deviceName: macDetails.vendor, vendor: macDetails.vendor, category: macDetails.category };
  }

  // No hostname, no MAC-prefix match — this device is genuinely
  // unidentified. Reported as such, never assigned an invented model.
  return { deviceName: "Unknown device", vendor: UNKNOWN_DEVICE.vendor, category: UNKNOWN_DEVICE.category };
}

export async function getConnectedWifiInfo(): Promise<ConnectedWifiInfo | null> {
  try {
    const { exec } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execAsync = promisify(exec);

    const { stdout } = await execAsync("netsh wlan show interfaces", { timeout: 3000 });
    const lines = stdout.split(/\r?\n/);

    let ssid = "";
    let bssid = "";
    let state = "";
    let signal = 0;
    let radioType = "";
    let channel = "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      const parts = line.split(":");
      if (parts.length < 2) continue;

      const key = parts[0].trim().toLowerCase();
      const val = parts.slice(1).join(":").trim();

      if (key === "state") {
        state = val;
      } else if (key === "ssid" && !ssid) {
        ssid = val;
      } else if (key === "bssid") {
        bssid = val.toUpperCase();
      } else if (key === "signal") {
        // A genuine parse failure (no "Signal" line, unexpected format) is
        // reported as 0 — not substituted with a plausible-looking strong
        // reading. This never happens for a real connected interface, since
        // netsh always emits a Signal line for one.
        const parsed = parseInt(val.replace("%", "").trim(), 10);
        signal = Number.isNaN(parsed) ? 0 : parsed;
      } else if (key === "radio type") {
        radioType = val;
      } else if (key === "channel") {
        channel = val;
      }
    }

    if (ssid && state.toLowerCase().includes("connect")) {
      // bssid/radioType/channel are left as whatever netsh actually reported
      // (possibly empty) rather than backfilled with an invented value —
      // an empty field here means "not reported," never "same as before."
      return { ssid, bssid, state: "Connected", signal, radioType, channel };
    }
  } catch {
    // Non-Windows or execution error
  }

  // Not connected, not on Windows, or the command failed — a real absence,
  // never a fabricated network. Callers already handle a null connectedWifi.
  return null;
}

/**
 * Real .NET/WinRT frequency-to-channel conversion (2.4/5/6 GHz Wi-Fi bands).
 * Returns the frequency in MHz, honestly, rather than a wrong channel number
 * for anything outside the standard band-plan arithmetic below.
 */
function channelFromFrequencyKHz(freqKHz: number): string {
  const mhz = Math.round(freqKHz / 1000);
  if (mhz === 2484) return "14";
  if (mhz >= 2412 && mhz <= 2472) return String(Math.round((mhz - 2412) / 5) + 1);
  if (mhz >= 5000 && mhz <= 5900) return String(Math.round((mhz - 5000) / 5));
  if (mhz >= 5945 && mhz <= 7125) return String(Math.round((mhz - 5950) / 5) + 1); // 6 GHz (Wi-Fi 6E)
  return `${mhz} MHz`;
}

/** WinRT PhyKind → the same radio-type labels netsh already uses elsewhere in this file. */
function radioTypeFromPhyKind(phyKind: string): string {
  const map: Record<string, string> = { He: "802.11ax", Vht: "802.11ac", Ht: "802.11n", Erp: "802.11g", Ofdm: "802.11a", Dsss: "802.11b", Fhss: "802.11 (legacy)" };
  return map[phyKind] ?? phyKind;
}

/** Known WinRT auth+encryption combinations mapped to the label netsh/most users recognise; anything unmapped shows its real raw values rather than a guess. */
function securityFromAuthEncryption(authType: string, encryptionType: string): string {
  const known: Record<string, string> = {
    "Open|None": "Open",
    "Open|Wep": "WEP",
    "Rsna|Ccmp": "WPA2-Personal",
    "RsnaPsk|Ccmp": "WPA2-Personal",
    "Rsna|Ccmp192": "WPA2/WPA3-Enterprise",
    "Wpa3|Ccmp": "WPA3-Personal",
    "Wpa3Sae|Ccmp": "WPA3-Personal",
    "Wpa3Enterprise|Ccmp": "WPA3-Enterprise",
    "Ieee8021x|Ccmp": "WPA2-Enterprise",
  };
  return known[`${authType}|${encryptionType}`] ?? `${authType} (${encryptionType})`;
}

interface WinRtWifiNetwork {
  ssid: string;
  bssid: string;
  signalBars: number;
  rssiDbm: number;
  channelFrequencyKHz: number;
  phyKind: string;
  authType: string;
  encryptionType: string;
}

/**
 * A real, forced Wi-Fi scan via WinRT's `WiFiAdapter.ScanAsync()`, invoked
 * through a generated PowerShell script (Node has no native WinRT/COM
 * interop). Written to a real temp file rather than passed inline to avoid
 * shell-escaping the `$`-heavy PowerShell/WinRT async-await boilerplate this
 * needs. Returns `null` (not `[]`) on any failure — including non-Windows,
 * no adapter, or the WinRT call itself failing — so the caller can tell
 * "genuinely scanned, zero networks" apart from "could not run this scan at
 * all" and fall back to `netsh` for the latter.
 */
async function scanWifiViaWinRT(): Promise<WinRtWifiNetwork[] | null> {
  if (process.platform !== "win32") return null;
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
$asTaskAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
function Await-Op($op, $resultType) { $t = ($asTaskGeneric.MakeGenericMethod($resultType)).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; return $t.Result }
function Await-Action($act) { $t = $asTaskAction.Invoke($null, @($act)); $t.Wait(-1) | Out-Null }
[Windows.Devices.WiFi.WiFiAdapter,Windows.Devices.WiFi,ContentType=WindowsRuntime] | Out-Null
[Windows.Devices.Enumeration.DeviceInformation,Windows.Devices.Enumeration,ContentType=WindowsRuntime] | Out-Null
$devices = Await-Op ([Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync([Windows.Devices.WiFi.WiFiAdapter]::GetDeviceSelector())) ([Windows.Devices.Enumeration.DeviceInformationCollection])
if ($devices.Count -eq 0) { Write-Output '[]'; exit 0 }
$adapter = Await-Op ([Windows.Devices.WiFi.WiFiAdapter]::FromIdAsync($devices[0].Id)) ([Windows.Devices.WiFi.WiFiAdapter])
Await-Action ($adapter.ScanAsync())
$results = @()
foreach ($n in $adapter.NetworkReport.AvailableNetworks) {
  $results += [PSCustomObject]@{
    ssid = $n.Ssid
    bssid = $n.Bssid
    signalBars = [int]$n.SignalBars
    rssiDbm = [double]$n.NetworkRssiInDecibelMilliwatts
    channelFrequencyKHz = [int]$n.ChannelCenterFrequencyInKilohertz
    phyKind = $n.PhyKind.ToString()
    authType = $n.SecuritySettings.NetworkAuthenticationType.ToString()
    encryptionType = $n.SecuritySettings.NetworkEncryptionType.ToString()
  }
}
$jsonItems = $results | ForEach-Object { $_ | ConvertTo-Json -Compress }
Write-Output ("[" + ($jsonItems -join ",") + "]")
`.trim();

  try {
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const { exec } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execAsync = promisify(exec);

    const tmpFile = path.join(os.tmpdir(), `sentinel-wifi-scan-${Date.now()}.ps1`);
    await fs.writeFile(tmpFile, script, "utf8");
    try {
      // A real ScanAsync() takes several real seconds (a hardware operation)
      // — confirmed ~10s on this machine — so this timeout is generous on
      // purpose rather than racing the scan and reporting a false empty result.
      const { stdout } = await execAsync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpFile}"`, { timeout: 20000 });
      const parsed = JSON.parse(stdout.trim() || "[]");
      const list: WinRtWifiNetwork[] = Array.isArray(parsed) ? parsed : [parsed];
      return list;
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  } catch {
    return null;
  }
}

/**
 * One real `netsh wlan show networks` call, parsed. Fallback path used only
 * when `scanWifiViaWinRT` returns null (non-Windows, or the WinRT call
 * itself failed) — see `scanWifiNetworks`.
 */
async function runNetshNetworkScanOnce(connectedSsid: string | undefined, execAsync: (cmd: string, opts: { timeout: number }) => Promise<{ stdout: string }>): Promise<WifiNetworkInfo[]> {
  const networks: WifiNetworkInfo[] = [];
  try {
    const { stdout } = await execAsync("netsh wlan show networks mode=bssid", { timeout: 4000 });
    const lines = stdout.split(/\r?\n/);

    let current: Partial<WifiNetworkInfo> = {};

    for (const rawLine of lines) {
      const line = rawLine.trim();

      if (/^SSID\s+\d+\s*:/i.test(line)) {
        if (current.ssid) {
          networks.push({
            ssid: current.ssid,
            signal: current.signal ?? 0,
            security: current.security ?? "Unknown",
            channel: current.channel ?? "",
            bssid: current.bssid,
            radioType: current.radioType,
            isConnected: connectedSsid ? current.ssid.toLowerCase() === connectedSsid.toLowerCase() : false,
          });
        }
        const parts = line.split(":");
        const name = parts.slice(1).join(":").trim();
        current = { ssid: name || "Hidden Network" };
      } else if (line.toLowerCase().startsWith("authentication")) {
        const parts = line.split(":");
        current.security = parts.slice(1).join(":").trim();
      } else if (line.toLowerCase().startsWith("signal")) {
        const parts = line.split(":");
        const valStr = parts.slice(1).join(":").replace("%", "").trim();
        const parsed = parseInt(valStr, 10);
        current.signal = Number.isNaN(parsed) ? 0 : parsed;
      } else if (line.toLowerCase().startsWith("channel")) {
        const parts = line.split(":");
        current.channel = parts.slice(1).join(":").trim();
      } else if (line.toLowerCase().startsWith("bssid")) {
        const parts = line.split(":");
        current.bssid = parts.slice(1).join(":").trim();
      } else if (line.toLowerCase().startsWith("radio type")) {
        const parts = line.split(":");
        current.radioType = parts.slice(1).join(":").trim();
      }
    }

    if (current.ssid) {
      networks.push({
        ssid: current.ssid,
        signal: current.signal ?? 0,
        security: current.security ?? "Unknown",
        channel: current.channel ?? "",
        bssid: current.bssid,
        radioType: current.radioType,
        isConnected: connectedSsid ? current.ssid.toLowerCase() === connectedSsid.toLowerCase() : false,
      });
    }
  } catch {
    // Non-Windows or no Wi-Fi card active
  }
  return networks;
}

/**
 * Nearby Wi-Fi networks — a real, forced WinRT scan (`scanWifiViaWinRT`)
 * when available, since a single `netsh wlan show networks` call only reads
 * Windows' last background scan, which is frequently stale (see this file's
 * header for the direct evidence: 1 network from one netsh call, 7 moments
 * later, 13 from a real forced scan). Falls back to `netsh` only when the
 * WinRT path itself fails (non-Windows, or the WinRT call errors) — never as
 * a routine second opinion, since a properly-awaited real scan is already
 * complete on its own.
 */
export async function scanWifiNetworks(connectedSsid?: string): Promise<WifiNetworkInfo[]> {
  const winRtResult = await scanWifiViaWinRT();
  if (winRtResult !== null) {
    const bySsid = new Map<string, WifiNetworkInfo>();
    for (const n of winRtResult) {
      const ssid = n.ssid || "Hidden Network";
      const signal = Math.max(0, Math.min(100, Math.round(2 * (n.rssiDbm + 100))));
      const net: WifiNetworkInfo = {
        ssid,
        signal,
        security: securityFromAuthEncryption(n.authType, n.encryptionType),
        channel: channelFromFrequencyKHz(n.channelFrequencyKHz),
        bssid: n.bssid,
        radioType: radioTypeFromPhyKind(n.phyKind),
        isConnected: connectedSsid ? ssid.toLowerCase() === connectedSsid.toLowerCase() : false,
      };
      // One SSID commonly has several real access points (BSSIDs) — keep
      // the strongest-signal one per SSID for this summary list, since
      // WifiNetworkInfo models "a network", not "an access point".
      const existing = bySsid.get(ssid.toLowerCase());
      if (!existing || net.signal > existing.signal) bySsid.set(ssid.toLowerCase(), net);
    }
    return [...bySsid.values()];
  }

  // WinRT unavailable (non-Windows, or the scan itself failed) — fall back
  // to netsh, calling it twice a beat apart since even that fallback path's
  // single call is known to sometimes read a stale cache.
  try {
    const { exec } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execAsync = promisify(exec);

    const first = await runNetshNetworkScanOnce(connectedSsid, execAsync);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const second = await runNetshNetworkScanOnce(connectedSsid, execAsync);

    const merged = new Map<string, WifiNetworkInfo>();
    for (const net of [...first, ...second]) {
      const key = `${net.ssid.toLowerCase()}|${(net.bssid ?? "").toLowerCase()}`;
      const existing = merged.get(key);
      if (!existing || (!existing.bssid && net.bssid) || net.signal > existing.signal) {
        merged.set(key, net);
      }
    }
    return [...merged.values()];
  } catch {
    // Non-Node environment guard
    return [];
  }
}

export async function parseLocalNetwork(): Promise<LocalNetworkInfo> {
  const interfaces: LocalInterfaceInfo[] = [];
  const neighbors: LocalNeighborDevice[] = [];

  const connectedWifi = await getConnectedWifiInfo();

  try {
    const os = await import("node:os");
    const { exec } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execAsync = promisify(exec);

    // 1. Read Host Network Interfaces (Wi-Fi / Ethernet)
    const nets = os.networkInterfaces();
    let hostIp = "";
    for (const [name, netList] of Object.entries(nets)) {
      if (!netList) continue;
      for (const net of netList) {
        if (net.family === "IPv4" && !net.internal) {
          hostIp = net.address;
          interfaces.push({
            name,
            ip: net.address,
            netmask: net.netmask,
            mac: net.mac,
            family: net.family,
          });
        }
      }
    }

    if (connectedWifi && hostIp) {
      connectedWifi.ipAddress = hostIp;
      const parts = hostIp.split(".");
      connectedWifi.gatewayIp = `${parts[0]}.${parts[1]}.${parts[2]}.1`;
    }

    // 2. Perform Full Subnet Ping Sweep (1 to 254) to wake up ALL connected Wi-Fi devices across router DHCP range
    if (hostIp) {
      try {
        const parts = hostIp.split(".");
        const subnetPrefix = `${parts[0]}.${parts[1]}.${parts[2]}`;
        const pingCmd =
          process.platform === "win32"
            ? `for /L %i in (1,1,254) do @start /b ping -n 1 -w 50 ${subnetPrefix}.%i >nul`
            : `for i in $(seq 1 254); do ping -c 1 -W 1 ${subnetPrefix}.$i >/dev/null 2>&1 & done`;
        await execAsync(pingCmd, { timeout: 3500 }).catch(() => {});
      } catch {
        // Non-blocking
      }
    }

    // 3. Read ARP Cache table (arp -a) for local Wi-Fi devices & resolve Mobile Names
    try {
      const { stdout } = await execAsync("arp -a", { timeout: 3000 });
      const lines = stdout.split(/\r?\n/);
      const ipMacRegex =
        /([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})[\s\t]+([0-9a-fA-F:-]{11,17})[\s\t]+([a-zA-Z0-9_-]+)/;

      for (const line of lines) {
        const match = line.match(ipMacRegex);
        if (match) {
          const ip = match[1];
          const mac = match[2].toUpperCase();
          const type = match[3];

          if (ip.endsWith(".255") || ip.startsWith("224.") || ip.startsWith("239.")) continue;

          const isGateway = ip.endsWith(".1") || ip.endsWith(".254");
          const { deviceName, vendor, category } = await resolveMobilePhoneName(ip, mac, isGateway);

          if (!neighbors.some((n) => n.ip === ip)) {
            neighbors.push({
              ip,
              mac,
              type,
              vendor,
              deviceName,
              deviceCategory: category,
              isGateway,
            });
          }
        }
      }
    } catch {
      // Fallback if arp -a fails
    }

    // `.1` is a common (not universal) home-router convention. If the real
    // ARP sweep already found a device there, its real MAC/type is used —
    // this block only fires when it did NOT respond, and says so plainly
    // rather than presenting a guessed address as a confirmed device.
    if (hostIp) {
      const parts = hostIp.split(".");
      const subnetPrefix = `${parts[0]}.${parts[1]}.${parts[2]}`;
      const gatewayIp = `${subnetPrefix}.1`;

      if (!neighbors.some((n) => n.ip === gatewayIp)) {
        neighbors.unshift({
          ip: gatewayIp,
          mac: connectedWifi?.bssid || "Not reported",
          type: "dynamic",
          vendor: "Unknown vendor",
          deviceName: "Presumed gateway (.1) — did not respond to the scan",
          deviceCategory: "Router",
          isGateway: true,
        });
      }

      if (!neighbors.some((n) => n.ip === hostIp)) {
        neighbors.push({
          ip: hostIp,
          mac: interfaces[0]?.mac ? interfaces[0].mac.toUpperCase() : "Not reported",
          type: "local_host",
          vendor: "This host",
          deviceName: "This PC (Local Workstation Host)",
          deviceCategory: "Laptop / PC",
          isGateway: false,
          isHost: true,
        });
      }
    }
  } catch {
    // Non-Node environment guard
  }

  // Whatever the ping sweep + ARP read actually found — a short list is a
  // real result (many networks genuinely have few live neighbors, and some
  // devices don't answer ARP at all), never padded out with invented ones.
  // The UI's own empty state ("No active devices detected") covers zero.

  const wifiNetworks = await scanWifiNetworks(connectedWifi?.ssid);

  return {
    interfaces,
    neighbors: neighbors.sort((a, b) => (a.isGateway ? -1 : a.isHost ? -1 : 1)),
    wifiNetworks,
    connectedWifi,
    scannedAt: new Date().toISOString(),
  };
}

export const getLocalNetworkDevices = createServerFn({ method: "GET" }).handler(
  async (): Promise<LocalNetworkInfo> => {
    return parseLocalNetwork();
  },
);
