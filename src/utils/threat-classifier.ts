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
  /** null when no indicator matched — the text is unclassified, not geopolitical. */
  primaryDomain: ThreatDomain | null;
  /** null when no indicator matched. "low" is a measurement; absence is not. */
  severity: ThreatSeverity | null;
  /** null when no indicator matched. Never a floor value. */
  score: number | null;
  indicators: string[];
  rationale: string;
}

const DOMAIN_INDICATORS: Record<
  ThreatDomain,
  { critical: string[]; high: string[]; medium: string[] }
> = {
  military: {
    critical: [
      "airstrike",
      "ballistic missile",
      "troop invasion",
      "nuclear threat",
      "full mobilization",
    ],
    high: [
      "artillery barrage",
      "naval blockade",
      "air defense active",
      "fighter jet intercept",
      "drone strike",
    ],
    medium: ["military exercise", "border patrol", "weapon deployment", "military convoy"],
  },
  cyber: {
    critical: [
      "critical infrastructure offline",
      "power grid hack",
      "zero-day exploit wild",
      "wiper attack",
    ],
    high: [
      "ransomware operational",
      "c2 server",
      "c2 intel",
      "malware host",
      "ddos state infrastructure",
      "data exfiltration",
      "exfiltration",
    ],
    medium: ["phishing campaign", "vulnerability disclosed", "port scanning", "credential leak"],
  },
  geopolitical: {
    critical: ["declaration of war", "diplomatic relations severed", "unanimous sanctions"],
    high: ["ambassador recalled", "treaty withdrawal", "embargo imposed", "expulsion diplomats"],
    medium: ["state summit", "diplomatic warning", "trade dispute", "border dispute"],
  },
  unrest: {
    critical: [
      "state of emergency",
      "curfew imposed",
      "violent riots",
      "government building stormed",
    ],
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
      primaryDomain: null,
      severity: null,
      score: null,
      indicators: [],
      rationale: "No text supplied, so nothing was evaluated.",
    };
  }

  const textLower = text.toLowerCase();
  /*
   * These start null, not at a floor.
   *
   * They were `severity = "low"`, `score = 0.2`, `domain = "geopolitical"`, so
   * text matching NOTHING in any taxonomy still produced
   * "Domain: GEOPOLITICAL · Severity: LOW · Confidence Score: 20%" — a
   * measurement presented for an evaluation that found nothing, in a file whose
   * own header promises "zero synthetic risk scores".
   *
   * `highestScore` is compared numerically below, so it keeps a numeric working
   * value; it is only published when an indicator actually matched.
   */
  let highestSeverity: ThreatSeverity | null = null;
  let highestScore = 0;
  let winningDomain: ThreatDomain | null = null;
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

  const matched = matchedIndicators.length > 0;

  return {
    // A taxonomy that matched nothing yields no domain, no severity and no
    // score. "Nothing matched" and "matched at the lowest level" are different
    // findings and an analyst acts differently on each.
    primaryDomain: matched ? winningDomain : null,
    severity: matched ? highestSeverity : null,
    score: matched ? highestScore : null,
    indicators: matchedIndicators,
    rationale: matched
      ? `Matched ${matchedIndicators.length} indicator(s) in ${winningDomain} taxonomy (${matchedIndicators.join(", ")}).`
      : "No indicator from any domain taxonomy matched this text. This is not a " +
        "finding that the subject is low risk — it is the absence of a keyword match, " +
        "and the taxonomies cover a deliberately narrow set of terms.",
  };
}
