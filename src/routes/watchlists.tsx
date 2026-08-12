import { createFileRoute } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useState, useEffect, useMemo } from "react";
import { getWatchlists, createWatchlist, deleteWatchlist } from "@/utils/watchlist-store";
import { Bookmark, Plus, Search, Trash2, Info } from "lucide-react";
import { toast } from "sonner";
import { SampleDataBanner } from "@/components/sample-data-banner";

/**
 * Tactical Watchlists.
 *
 * This page had NO CONTROLS AT ALL. It imported Button, Plus, Search, Trash2,
 * toast and createWatchlist and used none of them — a browser audit found four
 * interactive elements on the route, all of which belonged to the shared top
 * bar. A page titled "Tactical Watchlists" could not create, edit, delete,
 * search or filter one.
 *
 * Two claims also had nothing behind them:
 *
 *   - Every card carried a hardcoded green "ACTIVE" badge. Nothing schedules a
 *     watchlist, nothing runs it on a timer, and no process exists between
 *     requests to run it in — the container scales to zero. A status chip that
 *     is always green regardless of state is not a status.
 *   - The banner read "matches against live feeds are real", but this route
 *     computes no matches whatsoever. Matching lives in getWatchlistMatches and
 *     is driven from /subjects, against a corpus that page collects.
 */

export const Route = createFileRoute("/watchlists")({
  head: () => ({ meta: [{ title: "Watchlists — Sentinel AI" }] }),
  component: WatchlistsPage,
});

const CARD = "bg-[#111827] border-[#263548]";

function WatchlistsPage() {
  const [watchlists, setWatchlists] = useState<any[]>([]);
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [keywords, setKeywords] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const refresh = () => setWatchlists(getWatchlists());
  useEffect(refresh, []);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return watchlists;
    return watchlists.filter((w) => {
      const haystack = [
        w.name,
        w.description,
        ...(w.filters?.keywords ?? []),
        ...(w.filters?.organizations ?? []),
        ...(w.filters?.people ?? []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [watchlists, filter]);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setFormError("A watchlist needs a name.");
      return;
    }
    const terms = keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    if (terms.length === 0) {
      setFormError("Add at least one keyword — a watchlist with no terms matches nothing.");
      return;
    }
    createWatchlist(trimmed, description.trim(), {
      keywords: terms,
      organizations: [],
      people: [],
      countries: [],
      hashtags: [],
      domains: [],
      socialAccounts: [],
      emails: [],
      phones: [],
    });
    setFormError(null);
    setName("");
    setDescription("");
    setKeywords("");
    setCreating(false);
    refresh();
    toast.success(`Watchlist "${trimmed}" created.`);
  };

  const remove = (w: any) => {
    deleteWatchlist(w.id);
    refresh();
    toast.success(`Watchlist "${w.name}" deleted.`);
  };

  const seeded = watchlists.some((w) => String(w.name).startsWith("[SAMPLE]"));

  return (
    <AppShell>
      <PageHeader
        title="Tactical Watchlists"
        description="Keyword, entity and handle filters. Matching runs on demand against a collected corpus — nothing is scheduled."
      />
      {seeded && (
        <SampleDataBanner detail="Entries prefixed [SAMPLE] are seeded demonstration filters, not analyst-created." />
      )}

      <div className="space-y-6 p-6">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[#64748B]" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter watchlists by name, term, org or person…"
              className="h-9 border-[#263548] bg-[#0B1220] pl-8 font-mono text-xs text-white"
            />
          </div>
          <Button
            onClick={() => setCreating((v) => !v)}
            className="h-9 gap-1.5 bg-[#3B82F6] font-mono text-[10px] uppercase tracking-wider text-white hover:bg-[#3B82F6]/90"
          >
            <Plus className="size-3.5" />
            {creating ? "Cancel" : "New watchlist"}
          </Button>
        </div>

        {creating && (
          <Card className={CARD}>
            <CardHeader className="border-b border-[#263548] p-3">
              <CardTitle className="font-mono text-xs uppercase tracking-wider text-[#94A3B8]">
                New watchlist
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 p-4">
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1">
                  <label className="font-mono text-[10px] uppercase text-[#94A3B8]">Name</label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Eastern seaboard shipping"
                    className="h-8 border-[#263548] bg-[#0B1220] text-xs text-white"
                  />
                </div>
                <div className="space-y-1">
                  <label className="font-mono text-[10px] uppercase text-[#94A3B8]">
                    Description
                  </label>
                  <Input
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="What this filter is for"
                    className="h-8 border-[#263548] bg-[#0B1220] text-xs text-white"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <label className="font-mono text-[10px] uppercase text-[#94A3B8]">
                  Keywords (comma separated)
                </label>
                <Input
                  value={keywords}
                  onChange={(e) => setKeywords(e.target.value)}
                  placeholder="port closure, naval, blockade"
                  className="h-8 border-[#263548] bg-[#0B1220] text-xs text-white"
                />
              </div>
              {formError && <p className="font-mono text-[11px] text-[#EF4444]">{formError}</p>}
              <Button
                onClick={submit}
                className="h-8 bg-[#3B82F6] font-mono text-[10px] uppercase tracking-wider text-white hover:bg-[#3B82F6]/90"
              >
                Create
              </Button>
            </CardContent>
          </Card>
        )}

        {watchlists.length === 0 ? (
          <Card className={CARD}>
            <CardContent className="p-8 text-center">
              <Bookmark className="mx-auto mb-3 size-6 text-[#334155]" />
              <p className="font-mono text-xs text-[#94A3B8]">No watchlists yet.</p>
              <p className="mx-auto mt-2 max-w-md text-[11px] leading-relaxed text-[#64748B]">
                A watchlist is a saved set of terms. Create one here, then run it against a
                collected corpus on{" "}
                <Link to="/subjects" className="text-[#3B82F6] hover:underline">
                  Subjects
                </Link>{" "}
                — that page collects the material and computes the matches.
              </p>
            </CardContent>
          </Card>
        ) : visible.length === 0 ? (
          <Card className={CARD}>
            <CardContent className="p-8 text-center font-mono text-xs text-[#94A3B8]">
              No watchlist matches “{filter}”.
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {visible.map((w) => (
              <Card key={w.id} className={CARD}>
                <CardHeader className="border-b border-[#263548] pb-3">
                  <CardTitle className="flex items-center justify-between font-mono text-sm text-[#F3F4F6]">
                    <span className="flex min-w-0 items-center gap-2">
                      <Bookmark className="size-4 shrink-0 text-[#3B82F6]" />
                      <span className="truncate">{w.name}</span>
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => remove(w)}
                      aria-label={`Delete watchlist ${w.name}`}
                      className="size-7 shrink-0 p-0 text-[#64748B] hover:bg-[#EF4444]/10 hover:text-[#EF4444]"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 p-4 font-mono text-xs text-[#94A3B8]">
                  <div>Keywords: {w.filters?.keywords?.join(", ") || "none"}</div>
                  <div>Organisations: {w.filters?.organizations?.join(", ") || "none"}</div>
                  <div>People: {w.filters?.people?.join(", ") || "none"}</div>
                  <div className="border-t border-[#263548]/50 pt-2 text-[10px] text-[#64748B]">
                    {/*
                      This was a hardcoded green "ACTIVE" badge on every card.
                      Nothing schedules a watchlist and nothing runs it on a
                      timer — the container scales to zero, so there is no
                      process between requests to run one in.
                    */}
                    Not scheduled. Run this filter from{" "}
                    <Link to="/subjects" className="text-[#3B82F6] hover:underline">
                      Subjects
                    </Link>
                    .
                  </div>
                  {w.riskScore === null ? (
                    <div className="text-[10px] text-[#64748B]">
                      Risk index: not scored — no matches have been evaluated against this filter.
                    </div>
                  ) : (
                    <Badge className="border-[#3B82F6]/30 bg-[#3B82F6]/10 font-mono text-[10px] text-[#3B82F6]">
                      Risk index {w.riskScore}/100
                    </Badge>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        <Card className="border-[#263548] bg-[#0B1220]/60">
          <CardContent className="flex gap-3 p-4">
            <Info className="mt-0.5 size-4 shrink-0 text-[#3B82F6]" />
            <p className="text-[11px] leading-relaxed text-[#94A3B8]">
              Watchlists are stored in this browser only. They are not shared between operators, not
              audited, and are lost if site data is cleared. Scheduled monitoring is not implemented
              — matching is on demand, against whatever corpus the Subjects page has collected at
              that moment.
            </p>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
