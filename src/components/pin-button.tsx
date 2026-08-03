import React, { useState } from "react";
import { Bookmark, Check } from "lucide-react";
import { getInvestigations, pinToInvestigation, type PinnedEvidence } from "@/utils/investigations-store";
import { toast } from "sonner";

interface PinButtonProps {
  type: string;        // e.g. "News", "Social", "Image", "Video", "Entity"
  source: string;      // e.g. "BBC News", "@OSINTdefender"
  note: string;        // e.g. The headline, tweet text, or description
  tone?: PinnedEvidence["tone"];       // e.g. "high", "critical", "medium", "verified"
  data?: any;          // Raw item data
}

export function PinButton({ type, source, note, tone = "medium", data }: PinButtonProps) {
  const [isOpen, setIsOpen] = useState(false);

  const handlePin = (caseId: string, caseTitle: string) => {
    const success = pinToInvestigation(caseId, type, source, note, tone, data);
    if (success) {
      toast.success(`Pinned to case ${caseId} (${caseTitle.substring(0, 15)}...)`);
    } else {
      toast.error("Failed to pin item.");
    }
    setIsOpen(false);
  };

  const cases = getInvestigations();

  return (
    <div className="relative inline-block text-left font-mono">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen(!isOpen);
        }}
        className="flex items-center justify-center p-1 border border-[#263548] hover:border-[#3B82F6] bg-[#111827] hover:bg-[#1A2332] text-[#94A3B8] hover:text-[#3B82F6] rounded transition-colors"
        title="Pin to Investigation"
      >
        <Bookmark className="size-3.5" />
      </button>

      {isOpen && (
        <>
          <div 
            className="fixed inset-0 z-40" 
            onClick={(e) => {
              e.stopPropagation();
              setIsOpen(false);
            }} 
          />
          <div className="absolute right-0 mt-1 w-56 rounded border border-[#263548] bg-[#111827] shadow-xl z-50 text-[10px] text-[#94A3B8] overflow-hidden">
            <div className="border-b border-[#263548] bg-[#0B1220]/60 p-2 text-white font-bold uppercase text-[9px] tracking-wider">
              Pin to Case
            </div>
            <div className="max-h-40 overflow-y-auto p-1 space-y-0.5">
              {cases.length === 0 ? (
                <div className="p-2 text-center text-[#94A3B8]/60">
                  No active investigations.
                </div>
              ) : (
                cases.map((c) => (
                  <button
                    key={c.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      handlePin(c.id, c.title);
                    }}
                    className="w-full text-left px-2 py-1.5 hover:bg-[#1A2332] hover:text-white rounded flex items-center justify-between"
                  >
                    <span className="truncate max-w-[130px]">{c.title}</span>
                    <span className="text-[#06B6D4] text-[8px] font-bold font-mono">{c.id}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
