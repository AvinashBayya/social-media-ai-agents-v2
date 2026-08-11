/**
 * Cyber Threat Intelligence & CISA KEV Module
 *
 * Processes keyless CISA Known Exploited Vulnerabilities catalog feed and
 * malware indicator feeds.
 *
 * All data comes from open, keyless cybersecurity sources.
 */

export interface CyberVulnerability {
  cveID: string;
  vendorProject: string;
  product: string;
  vulnerabilityName: string;
  dateAdded: string;
  shortDescription: string;
  requiredAction: string;
  knownRansomwareCampaignUse: string;
}

export interface CyberIntelResponse {
  fetchedAt: string;
  source: string;
  totalVulnerabilities: number;
  recentCount: number;
  vulnerabilities: CyberVulnerability[];
}

let cachedCyber: CyberIntelResponse | null = null;
let cachedAt = 0;
const CACHE_TTL = 15 * 60 * 1000;

export async function fetchCyberIntel(
  endpoint = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json",
): Promise<CyberIntelResponse | null> {
  const now = Date.now();
  if (cachedCyber && now - cachedAt < CACHE_TTL) return cachedCyber;

  try {
    const resp = await fetch(endpoint, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) return cachedCyber;

    const raw = (await resp.json()) as any;
    if (!raw || !Array.isArray(raw.vulnerabilities)) return cachedCyber;

    const vulnerabilities: CyberVulnerability[] = raw.vulnerabilities.map((v: any) => ({
      cveID: String(v.cveID ?? ""),
      vendorProject: String(v.vendorProject ?? ""),
      product: String(v.product ?? ""),
      vulnerabilityName: String(v.vulnerabilityName ?? ""),
      dateAdded: String(v.dateAdded ?? ""),
      shortDescription: String(v.shortDescription ?? ""),
      requiredAction: String(v.requiredAction ?? ""),
      knownRansomwareCampaignUse: String(v.knownRansomwareCampaignUse ?? "Unknown"),
    }));

    cachedCyber = {
      fetchedAt: new Date().toISOString(),
      source: "CISA Known Exploited Vulnerabilities (KEV) Feed",
      totalVulnerabilities: vulnerabilities.length,
      recentCount: vulnerabilities.slice(0, 20).length,
      vulnerabilities,
    };
    cachedAt = now;
    return cachedCyber;
  } catch {
    return cachedCyber;
  }
}
