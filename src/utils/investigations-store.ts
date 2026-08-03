export interface PinnedEvidence {
  id: string;
  t: string;
  type: string;
  src: string;
  note: string;
  tone: "positive" | "negative" | "neutral" | "critical" | "high" | "medium" | "low" | "verified" | "unverified";
  data?: any;
}

export interface Investigation {
  id: string;
  target: string;
  title: string;
  description: string;
  status: "Active" | "Triage" | "Watch" | "Closed";
  owner: string;
  risk: number;
  threatScore: number;
  keywords: string[];
  entities: string[];
  media: any[];
  reports: any[];
  timeline: any[];
  evidence: PinnedEvidence[];
  notes: string;
  createdAt: string;
}

const DEFAULT_CASES: Investigation[] = [
  {
    id: "INV-2041",
    target: "Vector-17",
    title: "Vector-17 · surveillance leak",
    description: "Suspected exposure of internal surveillance program with imagery attributed to watchlist subject Vector-17. Cross-linked with fintech breach chatter.",
    status: "Active",
    owner: "A. Chen",
    risk: 78,
    threatScore: 82,
    keywords: ["surveillance", "leak", "imagery"],
    entities: ["Vector-17", "fintech vendor"],
    media: [],
    reports: [],
    timeline: [],
    evidence: [
      {
        id: "ev-1",
        t: "09:42",
        type: "Tweet",
        src: "@osint_watch",
        note: "Coordinated cluster identified — 4 accounts, 90s window.",
        tone: "high",
      },
      {
        id: "ev-2",
        t: "09:31",
        type: "Image",
        src: "Telegram · channel_9821",
        note: "EXIF corroborates capture time; geolocation within 200m.",
        tone: "critical",
      },
      {
        id: "ev-3",
        t: "08:58",
        type: "Doc",
        src: "Leaked PDF · anonfiles",
        note: "Redacted memo consistent with prior authentic sample.",
        tone: "high",
      }
    ],
    notes: "Main surveillance exposure case. Monitor Telegram wires closely.",
    createdAt: new Date().toISOString()
  },
  {
    id: "INV-2038",
    target: "Election Integrity",
    title: "#ElectionIntegrity CIB cluster",
    description: "Coordinated Inauthentic Behavior targeting electoral narratives using network of automated handles.",
    status: "Active",
    owner: "M. Ortega",
    risk: 88,
    threatScore: 90,
    keywords: ["election", "integrity", "CIB"],
    entities: ["Electoral narrative", "CIB cluster"],
    media: [],
    reports: [],
    timeline: [],
    evidence: [],
    notes: "Tracking bot profiles, sentiment analysis and social mentions.",
    createdAt: new Date().toISOString()
  }
];

export function getInvestigations(): Investigation[] {
  if (typeof window === "undefined") return DEFAULT_CASES;
  const store = localStorage.getItem("sentinel_investigations");
  if (!store) {
    localStorage.setItem("sentinel_investigations", JSON.stringify(DEFAULT_CASES));
    return DEFAULT_CASES;
  }
  try {
    return JSON.parse(store);
  } catch {
    return DEFAULT_CASES;
  }
}

export function saveInvestigations(list: Investigation[]) {
  if (typeof window !== "undefined") {
    localStorage.setItem("sentinel_investigations", JSON.stringify(list));
  }
}

export function createInvestigation(
  target: string,
  title: string,
  description: string,
  keywords: string[] = [],
  owner: string = "A. Chen"
): Investigation {
  const list = getInvestigations();
  const nextNum = list.length > 0 ? Math.max(...list.map(c => parseInt(c.id.split("-")[1]) || 2000)) + 1 : 2042;
  
  const newCase: Investigation = {
    id: `INV-${nextNum}`,
    target: target || "General",
    title: title || `${target} Investigation`,
    description: description || "Intel mission workspace.",
    status: "Active",
    owner: owner,
    risk: 50,
    threatScore: 50,
    keywords: keywords,
    entities: [target],
    media: [],
    reports: [],
    timeline: [],
    evidence: [],
    notes: "Case initialized.",
    createdAt: new Date().toISOString()
  };

  list.unshift(newCase);
  saveInvestigations(list);
  return newCase;
}

export function pinToInvestigation(
  caseId: string,
  type: string,
  src: string,
  note: string,
  tone: PinnedEvidence["tone"],
  data?: any
): boolean {
  const list = getInvestigations();
  const idx = list.findIndex(c => c.id === caseId);
  if (idx === -1) return false;

  const now = new Date();
  const timeStr = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`;

  const item: PinnedEvidence = {
    id: `ev-${Math.random().toString(36).substr(2, 9)}`,
    t: timeStr,
    type: type,
    src: src,
    note: note,
    tone: tone,
    data: data
  };

  list[idx].evidence.unshift(item);
  
  // Dynamically update entity and media lists based on pinned data
  if (type === "Image" || type === "Video") {
    list[idx].media.unshift(data || { title: note, source: src });
  }
  
  saveInvestigations(list);
  return true;
}

export function updateAnalystNotes(caseId: string, notes: string) {
  const list = getInvestigations();
  const idx = list.findIndex(c => c.id === caseId);
  if (idx !== -1) {
    list[idx].notes = notes;
    saveInvestigations(list);
  }
}
