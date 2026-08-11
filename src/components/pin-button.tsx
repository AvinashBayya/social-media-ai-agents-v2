import { useState } from "react";
import { Bookmark, Plus, Check } from "lucide-react";
import {
  createInvestigation,
  getInvestigations,
  pinToInvestigation,
  type PinInput,
} from "@/utils/investigations-store";
import { toast } from "sonner";

/**
 * Pin an item into an investigation case.
 *
 * This component existed with ZERO call sites, so no evidence could ever reach
 * a case and the seeded demonstration entries were all a case could contain.
 * It is now wired into News, Social and Image Intelligence.
 *
 * The full provenance travels with the pin — outlet, URL, publication time,
 * Module 1 credibility and the rationale behind that score — because the case
 * later becomes the source list for a Module 5 product, where every claim must
 * cite one of these items. A pin that lost its credibility score would produce
 * a product whose sources all read "not scored".
 */
export function PinButton({ payload, label }: { payload: PinInput; label?: string }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newTarget, setNewTarget] = useState("");

  const cases = open ? getInvestigations() : [];

  const pin = (caseId: string, title: string) => {
    const ok = pinToInvestigation(caseId, payload);
    if (ok) {
      setPinned(true);
      toast.success(`Pinned to ${caseId} · ${title.slice(0, 28)}`);
    } else {
      // The only failure that is not an error: the same URL is already in this
      // case. Saying so beats a generic failure toast.
      toast.info("Already pinned to that case, or the case no longer exists.");
    }
    setOpen(false);
  };

  const createAndPin = () => {
    const target = newTarget.trim();
    if (!target) return;
    const created = createInvestigation(target, `${target} investigation`, "", []);
    pin(created.id, created.title);
    setNewTarget("");
    setCreating(false);
  };

  return (
    <div className="relative inline-block text-left font-mono">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        className={`flex items-center gap-1 rounded border px-1.5 py-1 transition-colors ${
          pinned
            ? "border-[#10B981]/50 bg-[#10B981]/10 text-[#10B981]"
            : "border-[#263548] bg-[#111827] text-[#94A3B8] hover:border-[#3B82F6] hover:text-[#3B82F6]"
        }`}
        title={pinned ? "Pinned to a case" : "Pin to investigation"}
      >
        {pinned ? <Check className="size-3.5" /> : <Bookmark className="size-3.5" />}
        {label && <span className="text-[10px]">{label}</span>}
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              setCreating(false);
            }}
          />
          <div className="absolute right-0 z-50 mt-1 w-64 overflow-hidden rounded border border-[#263548] bg-[#111827] text-[10px] text-[#94A3B8] shadow-xl">
            <div className="border-b border-[#263548] bg-[#0B1220]/60 p-2 text-[9px] font-bold uppercase tracking-wider text-white">
              Pin to case
            </div>

            <div className="max-h-40 space-y-0.5 overflow-y-auto p-1">
              {cases.length === 0 ? (
                <div className="p-2 text-center text-[#64748B]">
                  No cases yet. Create one below — cases start empty; there is no seeded data.
                </div>
              ) : (
                cases.map((c) => (
                  <button
                    key={c.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      pin(c.id, c.title);
                    }}
                    className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left hover:bg-[#1A2332] hover:text-white"
                  >
                    <span className="max-w-[140px] truncate">{c.title}</span>
                    <span className="font-mono text-[8px] font-bold text-[#06B6D4]">
                      {c.evidence.length} ev
                    </span>
                  </button>
                ))
              )}
            </div>

            <div className="border-t border-[#263548] p-1.5">
              {creating ? (
                <div className="flex gap-1">
                  <input
                    autoFocus
                    value={newTarget}
                    onChange={(e) => setNewTarget(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") createAndPin();
                      if (e.key === "Escape") setCreating(false);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    placeholder="Subject…"
                    className="min-w-0 flex-1 rounded border border-[#263548] bg-[#0B1220] px-1.5 py-1 text-[10px] text-white outline-none focus:border-[#3B82F6]"
                  />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      createAndPin();
                    }}
                    disabled={!newTarget.trim()}
                    className="rounded bg-[#10B981] px-2 py-1 text-[9px] font-bold text-black disabled:opacity-40"
                  >
                    Pin
                  </button>
                </div>
              ) : (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setCreating(true);
                  }}
                  className="flex w-full items-center gap-1 rounded px-2 py-1.5 hover:bg-[#1A2332] hover:text-white"
                >
                  <Plus className="size-3" /> New case from this item
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
