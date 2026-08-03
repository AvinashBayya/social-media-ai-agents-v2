import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { getActiveTarget, setActiveTarget } from "@/utils/active-target";
import { AppShell, PageHeader, Tone } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Search, Mail, Phone, Globe, Twitter, FileText, MapPin } from "lucide-react";

export const Route = createFileRoute("/entities")({
  head: () => ({ meta: [{ title: "Entity Explorer — Sentinel AI" }] }),
  component: Page,
});

function Page() {
  const [target, setTarget] = useState(() => getActiveTarget());
  const [searchVal, setSearchVal] = useState(() => getActiveTarget());

  useEffect(() => {
    const initial = getActiveTarget();
    setTarget(initial);
    setSearchVal(initial);

    const handleTargetChange = (e: any) => {
      if (e.detail) {
        setTarget(e.detail);
        setSearchVal(e.detail);
      }
    };
    window.addEventListener("sentinel_target_changed", handleTargetChange);
    return () => window.removeEventListener("sentinel_target_changed", handleTargetChange);
  }, []);

  const handleSearch = () => {
    if (searchVal.trim()) {
      setActiveTarget(searchVal.trim());
    }
  };

  return (
    <AppShell>
      <PageHeader
        title="Entity Explorer"
        description="Search subjects, organizations, or identifiers and drill into their complete intelligence profile."
      />

      <Card className="mb-4">
        <CardContent className="p-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchVal}
              onChange={(e) => setSearchVal(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              placeholder="Search target subject or entity..."
              className="h-11 pl-9 pr-24 text-base"
            />
            <Button size="sm" onClick={handleSearch} className="absolute right-1.5 top-1/2 -translate-y-1/2">
              Search
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <Card>
          <CardContent className="p-5 text-center">
            <div className="mx-auto grid size-24 place-items-center rounded-full bg-gradient-to-br from-primary/30 to-primary/5 text-2xl font-bold text-primary font-mono">
              {target.slice(0, 3).toUpperCase()}
            </div>
            <h2 className="mt-3 text-lg font-semibold font-mono">{target}</h2>
            <p className="text-xs text-muted-foreground">Active Intelligence Subject</p>
            <div className="mt-3 flex justify-center gap-1.5">
              <Tone tone="critical" />
              <Tone tone="unverified" />
            </div>
            <div className="mt-4 rounded-md border bg-card p-3 text-left">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Risk score
              </div>
              <div className="mt-0.5 flex items-baseline justify-between">
                <span className="text-2xl font-semibold">88</span>
                <span className="text-xs text-destructive">+6 vs 7d</span>
              </div>
              <Progress value={88} className="mt-1.5 h-1.5" />
            </div>
            <dl className="mt-4 space-y-1 text-left text-xs">
              <div className="flex justify-between border-b py-1">
                <dt className="text-muted-foreground">Country</dt>
                <dd>SY / RU</dd>
              </div>
              <div className="flex justify-between border-b py-1">
                <dt className="text-muted-foreground">First seen</dt>
                <dd>2024-04-11</dd>
              </div>
              <div className="flex justify-between border-b py-1">
                <dt className="text-muted-foreground">Aliases</dt>
                <dd>V17, vect_seventeen</dd>
              </div>
              <div className="flex justify-between py-1">
                <dt className="text-muted-foreground">Mentions</dt>
                <dd>1,241</dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardContent className="p-4">
              <h3 className="text-sm font-semibold">Connected accounts & identifiers</h3>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {[
                  {
                    i: Twitter,
                    l: "@vect17_ghost",
                    n: "X / Twitter · 12K followers",
                    tone: "unverified" as const,
                  },
                  {
                    i: Twitter,
                    l: "channel_9821",
                    n: "Telegram · 48K subscribers",
                    tone: "unverified" as const,
                  },
                  {
                    i: Mail,
                    l: "vector17@proton.me",
                    n: "Email · confidence 82%",
                    tone: "medium" as const,
                  },
                  {
                    i: Phone,
                    l: "+91 98••••4211",
                    n: "Phone · reg. 2023-07",
                    tone: "medium" as const,
                  },
                  {
                    i: Globe,
                    l: "aster-motors.com",
                    n: "Domain · linked (indirect)",
                    tone: "low" as const,
                  },
                  {
                    i: MapPin,
                    l: "Damascus, SY",
                    n: "Recent location · ±180m",
                    tone: "high" as const,
                  },
                ].map((x, i) => (
                  <div key={i} className="flex items-start gap-2 rounded-md border bg-card p-2.5">
                    <span className="grid size-8 place-items-center rounded-md bg-primary/10 text-primary">
                      <x.i className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{x.l}</div>
                      <div className="text-[11px] text-muted-foreground">{x.n}</div>
                    </div>
                    <Tone tone={x.tone} />
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardContent className="p-4">
                <h3 className="text-sm font-semibold">Recent mentions</h3>
                <ul className="mt-3 space-y-2 text-sm">
                  {[
                    { s: "@osint_watch", t: "posts via channel_9821 — 90s window CIB.", d: "12m" },
                    { s: "BBC", t: "Report references watchlist subject alias.", d: "1h" },
                    { s: "r/netsec", t: "Analyst commentary on Damascus imagery.", d: "3h" },
                  ].map((m, i) => (
                    <li key={i} className="rounded-md border bg-card p-2.5">
                      <div className="flex justify-between text-[11px] text-muted-foreground">
                        <span>{m.s}</span>
                        <span>{m.d}</span>
                      </div>
                      <p className="text-sm">{m.t}</p>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <h3 className="text-sm font-semibold">Documents & images</h3>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div
                      key={i}
                      className="aspect-square rounded-md border"
                      style={{
                        background: `linear-gradient(135deg, oklch(0.7 0.12 ${(i * 55) % 360}), oklch(0.95 0.02 240))`,
                      }}
                    />
                  ))}
                </div>
                <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                  <FileText className="size-3.5" />3 documents · 12 images · 2 videos
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
