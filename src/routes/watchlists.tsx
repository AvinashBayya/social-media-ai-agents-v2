import { createFileRoute } from "@tanstack/react-router";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useState, useEffect } from "react";
import { getWatchlists, createWatchlist } from "@/utils/watchlist-store";
import { Bookmark, Plus, Shield, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/watchlists")({
  head: () => ({ meta: [{ title: "Watchlists — Sentinel AI" }] }),
  component: WatchlistsPage,
});

function WatchlistsPage() {
  const [watchlists, setWatchlists] = useState<any[]>([]);

  useEffect(() => {
    setWatchlists(getWatchlists());
  }, []);

  return (
    <AppShell>
      <PageHeader
        title="Tactical Watchlists"
        description="Monitor keyword triggers, handles, and entity clusters across open-source feeds."
      />

      <div className="p-6 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {watchlists.map((w) => (
            <Card key={w.id} className="bg-[#111827] border-[#263548]">
              <CardHeader className="border-b border-[#263548] pb-3">
                <CardTitle className="text-sm font-mono text-[#F3F4F6] flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <Bookmark className="size-4 text-[#3B82F6]" />
                    {w.name}
                  </span>
                  <Badge className="bg-[#10B981]/10 text-[#10B981] border-[#10B981]/30 font-mono text-[10px]">
                    ACTIVE
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-2 text-xs font-mono text-[#94A3B8]">
                <div>Target Keywords: {w.filters?.keywords?.join(", ") || "All"}</div>
                <div>Organizations: {w.filters?.organizations?.join(", ") || "None"}</div>
                <div>People: {w.filters?.people?.join(", ") || "None"}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
