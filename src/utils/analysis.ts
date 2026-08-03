/**
 * Module 2 — open-source content analysis.
 *
 * Summarisation and entity extraction live in `llm.ts`; this module adds the
 * part that needs no model at all: grouping articles that cover the same event.
 *
 * Clustering is greedy single-link over significant-token overlap of headlines.
 * That is deliberately cheap — no embeddings, no API call, no index. It is the
 * same signal Module 1 scores as `corroboration`, so a story appearing in a
 * cluster of five is simultaneously "5 sources reporting this" in the UI and a
 * high corroboration score on the credibility page. One computation, two uses.
 */

import { titleSimilarity } from "./credibility";

export interface ClusterableStory {
  id: string;
  title: string;
  /** Publisher domain or name — used to count INDEPENDENT carriers. */
  source: string;
  url?: string;
  pubDate?: string;
}

export interface StoryCluster {
  /** Id of the earliest-published member, used as the cluster's stable key. */
  id: string;
  /** Headline of the representative member. */
  title: string;
  members: ClusterableStory[];
  /** Distinct publishers carrying this story. */
  sources: string[];
}

/** Headlines at or above this token-overlap are treated as the same event. */
export const SAME_STORY_THRESHOLD = 0.42;

/**
 * Greedy single-link clustering. O(n²) on headline comparisons, which is fine
 * for the 35-item feed this runs against and avoids any dependency.
 */
export function clusterStories(stories: ClusterableStory[]): StoryCluster[] {
  const unassigned = [...stories];
  const clusters: StoryCluster[] = [];

  while (unassigned.length > 0) {
    const seed = unassigned.shift()!;
    const members = [seed];

    // Single-link: pull in anything similar to ANY current member, repeating
    // until nothing new joins, so a chain of related headlines stays together.
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = unassigned.length - 1; i >= 0; i -= 1) {
        const candidate = unassigned[i];
        if (members.some((m) => titleSimilarity(m.title, candidate.title) >= SAME_STORY_THRESHOLD)) {
          members.push(candidate);
          unassigned.splice(i, 1);
          grew = true;
        }
      }
    }

    const sources = Array.from(new Set(members.map((m) => m.source).filter(Boolean)));
    // Representative = earliest publication we have, i.e. who reported it first.
    const representative = [...members].sort(
      (a, b) => new Date(a.pubDate ?? 0).getTime() - new Date(b.pubDate ?? 0).getTime(),
    )[0];

    clusters.push({
      id: representative.id,
      title: representative.title,
      members,
      sources,
    });
  }

  return clusters.sort((a, b) => b.sources.length - a.sources.length);
}

/** Map of story id -> number of distinct publishers covering the same event. */
export function carrierCounts(stories: ClusterableStory[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const cluster of clusterStories(stories)) {
    for (const member of cluster.members) out[member.id] = cluster.sources.length;
  }
  return out;
}
