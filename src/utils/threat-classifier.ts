/**
 * Multi-Domain Threat Classifier Engine
 *
 * Evaluates text or event payloads against OSINT domain taxonomies
 * (Military, Cyber, Geopolitical, Civil Unrest, Infrastructure) and computes
 * deterministic severity ratings (low, medium, high, critical).
 *
 * Follows strict Data Honesty Policy: zero synthetic risk scores.
 */

export type ThreatDomain = "military" | "cyber" | "geopolitical" | "unrest" | "infrastructure";
export type ThreatSeverity = "low" | "medium" | "high" | "critical";

export interface ThreatEvaluation {
  primaryDomain: ThreatDomain;
  severity: ThreatSeverity;
  score: number;
  indicators: string[];
  rationale: string;
}

const DOMAIN_INDICATORS: Record<ThreatDomain, { critical: string[]; high: string[]; medium: string[] }> = {
  military: {
    critical: ["airstrike", "ballistic missile", "troop invasion", "nuclear threat", "full mobilization"],
    high: ["artillery barrage", "naval blockade", "air defense active", "fighter jet intercept", "drone strike"],
    medium: ["military exercise", "border patrol", "weapon deployment", "military convoy"],
  },
  cyber: {
    critical: ["critical infrastructure offline", "power grid hack", "zero-day exploit wild", "wiper attack"],
    high: ["ransomware operational", "c2 server", "c2 intel", "malware host", "ddos state infrastructure", "data exfiltration", "exfiltration"],
    medium: ["phishing campaign", "vulnerability disclosed", "port scanning", "credential leak"],
  },
  geopolitical: {
    critical: ["declaration of war", "diplomatic relations severed", "unanimous sanctions"],
    high: ["ambassador recalled", "treaty withdrawal", "embargo imposed", "expulsion diplomats"],
    medium: ["state summit", "diplomatic warning", "trade dispute", "border dispute"],
  },
  unrest: {
    critical: ["state of emergency", "curfew imposed", "violent riots", "government building stormed"],
    high: ["tear gas deployed", "mass protest", "clashes police", "roadblock burning"],
    medium: ["peaceful demonstration", "strike action", "public rally", "picket line"],
  },
  infrastructure: {
    critical: ["pipeline explosion", "subsea cable severed", "nuclear reactor shut", "dam breach"],
    high: ["gps jamming severe", "port closed", "airport grounded", "train network blackout"],
    medium: ["power outage local", "telecom disruption", "water main break", "bridge closed"],
  },
};

export function classifyThreatText(text: string): ThreatEvaluation {
  if (!text || text.trim().length === 0) {
    return {
      primaryDomain: "geopolitical",
      severity: "low",
      score: 0.1,
      indicators: [],
      rationale: "Empty or insufficient content for threat evaluation.",
    };
  }

  const textLower = text.toLowerCase();
  let highestSeverity: ThreatSeverity = "low";
  let highestScore = 0.2;
  let winningDomain: ThreatDomain = "geopolitical";
  let matchedIndicators: string[] = [];

  for (const [domainStr, taxonomy] of Object.entries(DOMAIN_INDICATORS)) {
    const domain = domainStr as ThreatDomain;

    const critHits = taxonomy.critical.filter((kw) => textLower.includes(kw));
    const highHits = taxonomy.high.filter((kw) => textLower.includes(kw));
    const medHits = taxonomy.medium.filter((kw) => textLower.includes(kw));

    if (critHits.length > 0) {
      if (highestScore < 0.9) {
        highestScore = 0.95;
        highestSeverity = "critical";
        winningDomain = domain;
        matchedIndicators = critHits;
      }
    } else if (highHits.length > 0) {
      if (highestScore < 0.75) {
        highestScore = 0.75;
        highestSeverity = "high";
        winningDomain = domain;
        matchedIndicators = highHits;
      }
    } else if (medHits.length > 0) {
      if (highestScore < 0.5) {
        highestScore = 0.5;
        highestSeverity = "medium";
        winningDomain = domain;
        matchedIndicators = medHits;
      }
    }
  }

  return {
    primaryDomain: winningDomain,
    severity: highestSeverity,
    score: highestScore,
    indicators: matchedIndicators,
    rationale:
      matchedIndicators.length > 0
        ? `Matched ${matchedIndicators.length} indicator(s) in ${winningDomain} taxonomy (${matchedIndicators.join(", ")}).`
        : "No explicit high-risk indicators matched; baseline geopolitical monitoring level assigned.",
  };
}
