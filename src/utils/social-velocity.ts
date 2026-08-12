/**
 * Social Velocity & Spike Acceleration Engine
 *
 * Computes social media volume velocity, keyword frequency acceleration,
 * and temporal posting spikes across social streams (Bluesky, Telegram, Mastodon).
 */

import type { SocialPost } from "./social";

export interface VelocityMetric {
  term: string;
  count: number;
  previousCount: number;
  velocityRatio: number;
  isSpike: boolean;
}

export interface SocialVelocitySummary {
  totalPostsProcessed: number;
  timeWindowMinutes: number;
  topVelocityTerms: VelocityMetric[];
  spikesDetected: number;
}

const STOP_WORDS = new Set([
  "the",
  "be",
  "to",
  "of",
  "and",
  "a",
  "in",
  "that",
  "have",
  "i",
  "it",
  "for",
  "not",
  "on",
  "with",
  "he",
  "as",
  "you",
  "do",
  "at",
  "this",
  "but",
  "his",
  "by",
  "from",
  "they",
  "we",
  "say",
  "her",
  "she",
  "or",
  "an",
  "will",
  "my",
  "one",
  "all",
  "would",
  "there",
  "their",
  "what",
  "so",
  "up",
  "out",
  "if",
  "about",
  "who",
  "get",
  "which",
  "go",
  "me",
  "http",
  "https",
]);

export function calculateSocialVelocity(
  posts: SocialPost[],
  windowMinutes = 60,
  minFrequency = 2,
): SocialVelocitySummary {
  if (!posts || posts.length === 0) {
    return {
      totalPostsProcessed: 0,
      timeWindowMinutes: windowMinutes,
      topVelocityTerms: [],
      spikesDetected: 0,
    };
  }

  const now = Date.now();
  const halfWindowMs = (windowMinutes / 2) * 60 * 1000;
  const fullWindowMs = windowMinutes * 60 * 1000;

  const recentCounts = new Map<string, number>();
  const previousCounts = new Map<string, number>();

  for (const p of posts) {
    const postTime = new Date(p.createdAt).getTime();
    if (!Number.isFinite(postTime)) continue;

    const age = now - postTime;
    if (age > fullWindowMs) continue;

    const isRecent = age <= halfWindowMs;
    const tokens = p.text
      .toLowerCase()
      .replace(/[^\w\s#]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOP_WORDS.has(t));

    for (const t of tokens) {
      if (isRecent) {
        recentCounts.set(t, (recentCounts.get(t) ?? 0) + 1);
      } else {
        previousCounts.set(t, (previousCounts.get(t) ?? 0) + 1);
      }
    }
  }

  const metrics: VelocityMetric[] = [];
  for (const [term, recentCount] of recentCounts.entries()) {
    if (recentCount < minFrequency) continue;
    const prevCount = previousCounts.get(term) ?? 0;
    const velocityRatio =
      prevCount === 0 ? recentCount * 2.0 : Number((recentCount / prevCount).toFixed(2));
    const isSpike = velocityRatio >= 2.5 && recentCount >= 3;

    metrics.push({
      term,
      count: recentCount,
      previousCount: prevCount,
      velocityRatio,
      isSpike,
    });
  }

  metrics.sort((a, b) => b.velocityRatio - a.velocityRatio || b.count - a.count);

  return {
    totalPostsProcessed: posts.length,
    timeWindowMinutes: windowMinutes,
    topVelocityTerms: metrics.slice(0, 15),
    spikesDetected: metrics.filter((m) => m.isSpike).length,
  };
}
