import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Users,
  Loader2,
  AlertTriangle,
  Plus,
  X,
  ExternalLink,
  Info,
  Network as NetworkIcon,
} from "lucide-react";
import {
  socialProfile,
  socialAuthorFeed,
  type BlueskyProfile,
  type SocialPost,
} from "@/utils/social";
import { accountMaturity, analyseCib, CIB_CAVEAT, type CibCluster } from "@/utils/cib";

/**
 * Network Analysis — Module 3.
 *
 * The previous version of this page shipped five named clusters with invented
 * sizes and "bot likelihood" percentages (76%, 22%, 4%…), five influencers with
 * fabricated follower counts and "reach" scores, and an SVG of 3,980 nodes drawn
 * from a loop index with the caption "Modularity 0.71 · avg. degree 6.2". None of
 * it was measured. The bot figures in particular were the exact thing PS-18 asks
 * this module to do, asserted rather than computed.
 *
 * This version holds nothing until an analyst names an account. Then it fetches
 * that account's real profile and recent posts from Bluesky's public AppView and
 * reports what those contain — with an empty state, not a placeholder, when
 * nothing has been fetched.
 */

export const Route = createFileRoute("/network")({
  head: () => ({ meta: [{ title: "Network Analysis — Sentinel AI" }] }),
  component: Page,
});

const CARD = "bg-[#111827] border-[#263548]";

interface Subject {
  profile: BlueskyProfile;
  posts: SocialPost[];
  /** Account-maturity assessment for this one account, from its real numbers. */
  maturityScore: number | null;
  maturityEvidence: string;
}

function fmt(n: number | null): string {
  // "—" and "0" are different findings: one is an absent field, the other a
  // measured zero. They must not render the same.
  return n === null ? "—" : n.toLocaleString();
}

function ageOf(createdAt: string | null): { days: number; label: string } | null {
  if (!createdAt) return null;
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return null;
  const days = (Date.now() - t) / 86_400_000;
  const label =
    days < 1
      ? "under a day"
      : days < 60
        ? `${Math.round(days)} days`
        : days < 730
          ? `${Math.round(days / 30)} months`
          : `${(days / 365).toFixed(1)} years`;
  return { days, label };
}

function Page() {
  const [handle, setHandle] = useState("");
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [clusters, setClusters] = useState<CibCluster[] | null>(null);

  const add = async () => {
    const actor = handle.trim().replace(/^@/, "");
    if (!actor || subjects.some((s) => s.profile.handle === actor || s.profile.did === actor))
      return;
    setBusy(true);
    setError("");
    try {
      const profile = (await socialProfile({ data: { actor } })) as unknown as BlueskyProfile;
      // The feed is fetched separately so a profile still renders if the feed
      // call fails — partial data is reported as partial, not discarded.
      let posts: SocialPost[] = [];
      let feedNote = "";
      try {
        posts = (await socialAuthorFeed({ data: { actor, limit: 50 } })) as unknown as SocialPost[];
      } catch (err: any) {
        feedNote = err?.message ?? String(err);
      }

      const { signal } = accountMaturity(
        posts.length
          ? posts
          : [
              {
                id: profile.did,
                platform: "bluesky" as const,
                author: profile.handle,
                authorId: profile.did,
                text: "",
                createdAt: profile.createdAt ?? "",
                url: "",
                langs: [],
                links: [],
              },
            ],
        [profile],
      );

      setSubjects((prev) => [
        ...prev,
        {
          profile,
          posts,
          maturityScore: signal.score,
          maturityEvidence: signal.score === null ? (signal.skipped ?? "") : signal.evidence,
        },
      ]);
      if (feedNote) setError(`Profile loaded, but the post feed failed: ${feedNote}`);
      setHandle("");
      setClusters(null);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = (did: string) => {
    setSubjects((prev) => prev.filter((s) => s.profile.did !== did));
    setClusters(null);
  };

  const analyse = () => {
    const posts = subjects.flatMap((s) => s.posts);
    setClusters(analyseCib(posts, { profiles: subjects.map((s) => s.profile) }));
  };

  const totalPosts = subjects.reduce((n, s) => n + s.posts.length, 0);

  return (
    <AppShell>
      <PageHeader
        title="Network Analysis"
        description="Account-level analysis from Bluesky's public AppView. Every figure is fetched, not modelled."
      />

      <Card className={CARD}>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[240px] flex-1">
              <label className="text-[10px] uppercase tracking-wider text-[#64748B]">
                Bluesky handle or DID
              </label>
              <Input
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && add()}
                placeholder="e.g. bsky.app"
                className="mt-1 h-8 border-[#263548] bg-[#0B1220] text-[12px] text-white"
              />
            </div>
            <Button size="sm" disabled={busy || !handle.trim()} onClick={add} className="h-8 gap-1">
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
              Add account
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={totalPosts < 4}
              onClick={analyse}
              className="h-8 gap-1"
              title={totalPosts < 4 ? "Add accounts with at least 4 posts between them" : undefined}
            >
              <NetworkIcon className="size-3.5" />
              Cross-account analysis
            </Button>
          </div>

          {error && (
            <div className="mt-3 flex items-start gap-2 rounded border border-[#EF4444]/30 bg-[#EF4444]/5 p-2">
              <AlertTriangle className="size-3.5 shrink-0 text-[#EF4444]" />
              <span className="font-mono text-[10px] leading-relaxed text-[#EF4444]">{error}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {subjects.length === 0 ? (
        <Card className={`${CARD} mt-4`}>
          <CardContent className="p-10 text-center">
            <Users className="mx-auto size-8 text-[#263548]" />
            <p className="mt-3 text-sm text-[#94A3B8]">No accounts loaded.</p>
            <p className="mx-auto mt-1 max-w-md text-[11px] leading-relaxed text-[#64748B]">
              This page holds no data of its own. Add a Bluesky handle above and its profile and
              recent posts are fetched from the public AppView. Follower counts, account age and
              post volume come from the platform; nothing here is estimated or modelled.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {subjects.map((s) => {
            const age = ageOf(s.profile.createdAt);
            const perDay =
              s.profile.postsCount !== null && age && age.days > 0
                ? s.profile.postsCount / age.days
                : null;
            return (
              <Card key={s.profile.did} className={CARD}>
                <CardContent className="p-3.5">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <a
                        href={`https://bsky.app/profile/${s.profile.handle || s.profile.did}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 truncate text-sm font-semibold text-white hover:underline"
                      >
                        {s.profile.displayName || s.profile.handle}
                        <ExternalLink className="size-3 shrink-0 text-[#64748B]" />
                      </a>
                      <div className="truncate font-mono text-[10px] text-[#64748B]">
                        @{s.profile.handle}
                      </div>
                    </div>
                    <button
                      onClick={() => remove(s.profile.did)}
                      className="shrink-0 text-[#64748B] hover:text-[#EF4444]"
                      aria-label={`Remove ${s.profile.handle}`}
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>

                  <dl className="mt-3 space-y-1 border-t border-[#263548] pt-2 font-mono text-[10px]">
                    <div className="flex justify-between">
                      <dt className="text-[#64748B]">Followers</dt>
                      <dd className="tabular-nums text-white">{fmt(s.profile.followersCount)}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-[#64748B]">Following</dt>
                      <dd className="tabular-nums text-white">{fmt(s.profile.followsCount)}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-[#64748B]">Posts</dt>
                      <dd className="tabular-nums text-white">{fmt(s.profile.postsCount)}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-[#64748B]">Account age</dt>
                      <dd className="text-white">{age ? age.label : "—"}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-[#64748B]">Posts / day</dt>
                      <dd className="tabular-nums text-white">
                        {perDay === null ? "—" : perDay.toFixed(1)}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-[#64748B]">Feed fetched</dt>
                      <dd className="tabular-nums text-white">{s.posts.length}</dd>
                    </div>
                  </dl>

                  <div className="mt-2 border-t border-[#263548] pt-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] uppercase tracking-wider text-[#64748B]">
                        Maturity concern
                      </span>
                      <span
                        className={`ml-auto font-mono text-[10px] ${
                          s.maturityScore === null
                            ? "text-[#64748B]"
                            : s.maturityScore >= 0.6
                              ? "text-[#EF4444]"
                              : s.maturityScore >= 0.3
                                ? "text-[#F59E0B]"
                                : "text-[#10B981]"
                        }`}
                      >
                        {s.maturityScore === null ? "not computed" : s.maturityScore.toFixed(2)}
                      </span>
                    </div>
                    <p className="mt-1 text-[9px] leading-relaxed text-[#94A3B8]">
                      {s.maturityEvidence}
                    </p>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {clusters !== null && (
        <Card className={`${CARD} mt-4`}>
          <CardContent className="p-4">
            <h3 className="text-xs font-bold uppercase text-white">
              Cross-account coordination signals
            </h3>
            <p className="mt-2 rounded border border-[#F59E0B]/30 bg-[#F59E0B]/5 p-2 text-[10px] leading-relaxed text-[#F59E0B]">
              {CIB_CAVEAT}
            </p>

            {clusters.length === 0 ? (
              <p className="mt-3 text-[11px] text-[#64748B]">
                No two posts across these {subjects.length} account(s) are similar enough to form a
                cluster. That is an absence of overlap, not a finding that the accounts are
                unrelated.
              </p>
            ) : (
              <div className="mt-3 space-y-2">
                {clusters.slice(0, 8).map((c) => (
                  <div
                    key={c.id}
                    className={`rounded border p-2.5 ${
                      c.flagged
                        ? "border-[#EF4444]/50 bg-[#EF4444]/5"
                        : "border-[#263548] bg-[#0B1220]/60"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-semibold text-white">
                        {c.accounts.length} account(s), {c.posts.length} posts
                      </span>
                      <span className="ml-auto font-mono text-[10px] text-[#94A3B8]">
                        {c.compositeScore === null
                          ? "unscored"
                          : `${c.compositeScore.toFixed(2)} · ${c.signalsComputed}/5 signals`}
                      </span>
                      {c.flagged && (
                        <Badge className="border-[#EF4444]/40 bg-[#EF4444]/10 text-[9px] font-normal text-[#EF4444]">
                          review
                        </Badge>
                      )}
                    </div>
                    <ul className="mt-1.5 space-y-0.5">
                      {c.signals.map((sig) => (
                        <li key={sig.id} className="text-[10px] leading-relaxed text-[#94A3B8]">
                          <span className="font-semibold text-white">{sig.label}</span>{" "}
                          <span className="font-mono">
                            {sig.score === null ? "not computed" : sig.score.toFixed(2)}
                          </span>{" "}
                          — {sig.score === null ? sig.skipped : sig.evidence}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card className={`${CARD} mt-4`}>
        <CardContent className="flex items-start gap-2 p-3">
          <Info className="size-3.5 shrink-0 text-[#64748B]" />
          <p className="text-[10px] leading-relaxed text-[#94A3B8]">
            Bluesky's follow graph is public and could be walked to build a genuine community
            structure, which is what a modularity figure would need. That is not built, so no
            modularity, node count or "reach" score is shown — an invented one would be
            indistinguishable from a measured one on the page.
          </p>
        </CardContent>
      </Card>
    </AppShell>
  );
}
