/**
 * Telegram Intelligence Topic Classifier & Early Signal Module
 *
 * Classifies Telegram previews and posts into OSINT threat topics
 * (breaking, conflict, geopolitics, osint, cyber) and identifies early signals.
 */

import type { SocialPost } from "./social";

export type TelegramTopic = "all" | "breaking" | "conflict" | "geopolitics" | "osint" | "cyber";

export interface TelegramIntelItem {
  id: string;
  channel: string;
  text: string;
  url: string;
  createdAt: string;
  topic: TelegramTopic;
  earlySignal: boolean;
  keywordsMatched: string[];
}

const TOPIC_KEYWORDS: Record<Exclude<TelegramTopic, "all">, string[]> = {
  breaking: ["flash", "urgent", "breaking", "just in", "alert", "siren"],
  conflict: [
    "strike",
    "missile",
    "shelling",
    "troop",
    "forces",
    "artillery",
    "drone",
    "blast",
    "explosion",
  ],
  geopolitics: [
    "treaty",
    "sanctions",
    "diplomat",
    "summit",
    "ambassador",
    "ministry",
    "minister",
    "president",
  ],
  osint: [
    "geolocation",
    "satellite",
    "coordinates",
    "flight",
    "adsb",
    "imagery",
    "aircraft",
    "vessel",
  ],
  cyber: ["ddos", "ransomware", "malware", "breach", "hack", "cve", "zero-day", "exploit", "cisa"],
};

export function classifyTelegramPost(post: SocialPost): TelegramIntelItem {
  const textLower = post.text.toLowerCase();
  let matchedTopic: TelegramTopic = "osint";
  let maxMatches = 0;
  let matchedKeywords: string[] = [];

  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    const hits = keywords.filter((kw) => textLower.includes(kw));
    if (hits.length > maxMatches) {
      maxMatches = hits.length;
      matchedTopic = topic as TelegramTopic;
      matchedKeywords = hits;
    }
  }

  const isBreakingHits = TOPIC_KEYWORDS.breaking.some((kw) => textLower.includes(kw));
  const isEarlySignal = isBreakingHits || maxMatches >= 2;

  return {
    id: post.id,
    channel: post.author,
    text: post.text,
    url: post.url,
    createdAt: post.createdAt,
    topic: matchedTopic,
    earlySignal: isEarlySignal,
    keywordsMatched: matchedKeywords,
  };
}

export function processTelegramIntelFeed(
  posts: SocialPost[],
  topicFilter: TelegramTopic = "all",
): TelegramIntelItem[] {
  const items = posts.map(classifyTelegramPost);
  if (topicFilter === "all") return items;
  return items.filter((item) => item.topic === topicFilter);
}
