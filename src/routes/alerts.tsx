import { createFileRoute, Link } from "@tanstack/react-router";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { BellOff, Info } from "lucide-react";

/**
 * Alert Centre.
 *
 * The three alerts that used to render here were invented — the live target
 * interpolated into a template, with fake relative timestamps ("12m ago") so
 * they read as a live feed. Removing them was right. What was left behind was a
 * mapped empty array with NO empty-state branch, so the route rendered 178
 * characters of body text: a title, a description, and then nothing. A browser
 * audit reported it as a blank page, which is exactly how an operator would
 * read it — as broken rather than as correct.
 *
 * /timeline solves the same problem properly, so this copies that pattern:
 * explain what would populate the view, say plainly why nothing does yet, and
 * link to the pages that carry the equivalent signal today.
 */

export const Route = createFileRoute("/alerts")({
  head: () => ({ meta: [{ title: "Alert Center — Sentinel AI" }] }),
  component: AlertsPage,
});

/** What an alert would have to be computed FROM, and where that lives now. */
const WOULD_REQUIRE = [
  {
    trigger: "Volume anomaly on a monitored subject",
    needs: "A scheduled collector and a stored baseline to compare against.",
    today: "Spike detection runs live in the browser while the Social page is open.",
    to: "/social" as const,
    label: "Social",
  },
  {
    trigger: "A watchlist term matching new material",
    needs: "A scheduled run of each saved watchlist against a fresh corpus.",
    today: "Watchlists are matched on demand against a corpus you collect.",
    to: "/subjects" as const,
    label: "Subjects",
  },
  {
    trigger: "A threat indicator matching a monitored asset",
    needs: "Persisted assets and a scheduled diff against the blocklists.",
    today: "Indicators are fetched and shown on demand.",
    to: "/osint" as const,
    label: "OSINT",
  },
];

function AlertsPage() {
  return (
    <AppShell>
      <PageHeader
        title="Alert Centre"
        description="Nothing is alerting. Alerting needs a scheduler, and this system has none."
      />

      <div className="space-y-4 p-6">
        <Card className="border-[#263548] bg-[#111827]">
          <CardContent className="p-8 text-center">
            <BellOff className="mx-auto mb-3 size-7 text-[#334155]" />
            <p className="font-mono text-sm text-[#F3F4F6]">No alerts</p>
            <p className="mx-auto mt-2 max-w-lg text-[11px] leading-relaxed text-[#94A3B8]">
              This is not an empty result from a working alert pipeline — there is no alert
              pipeline. Nothing computes volume spikes on a schedule, matches watchlists in the
              background, or diffs threat feeds against monitored assets.
            </p>
            <p className="mx-auto mt-2 max-w-lg text-[11px] leading-relaxed text-[#64748B]">
              The container scales to zero, so there is no process between requests to run a
              schedule in. Alerting needs persistence and a worker; both are listed as outstanding
              infrastructure, not as features that exist and happen to be quiet.
            </p>
          </CardContent>
        </Card>

        <Card className="border-[#263548] bg-[#111827]">
          <CardContent className="p-4">
            <h2 className="mb-3 font-mono text-[10px] uppercase tracking-widest text-[#94A3B8]">
              What each alert type would need, and where the signal is today
            </h2>
            <div className="space-y-3">
              {WOULD_REQUIRE.map((row) => (
                <div
                  key={row.trigger}
                  className="border-b border-[#263548]/40 pb-3 last:border-0 last:pb-0"
                >
                  <div className="font-mono text-xs font-bold text-[#F3F4F6]">{row.trigger}</div>
                  <div className="mt-1 text-[11px] leading-relaxed text-[#94A3B8]">
                    <span className="text-[#64748B]">Requires:</span> {row.needs}
                  </div>
                  <div className="mt-0.5 text-[11px] leading-relaxed text-[#94A3B8]">
                    <span className="text-[#64748B]">Today:</span> {row.today}{" "}
                    <Link to={row.to} className="text-[#3B82F6] hover:underline">
                      Open {row.label}
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="border-[#263548] bg-[#0B1220]/60">
          <CardContent className="flex gap-3 p-4">
            <Info className="mt-0.5 size-4 shrink-0 text-[#3B82F6]" />
            <p className="text-[11px] leading-relaxed text-[#94A3B8]">
              The notification bell in the top bar is inert for the same reason. It is not wired to
              anything, and it no longer displays an unread indicator.
            </p>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
