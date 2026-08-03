import React from "react";
import { ShieldAlert, Compass, Sparkles, MapPin, RefreshCw, AlertTriangle, FileText, ClipboardList } from "lucide-react";
import { Badge } from "@/components/ui/badge";

// Tactical container block
export function ReportBlock({
  title,
  subtitle,
  children,
  badge,
  borderColor = "border-[#263548]",
  accentColor = "bg-[#3B82F6]",
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  badge?: React.ReactNode;
  borderColor?: string;
  accentColor?: string;
}) {
  return (
    <div className={`relative border ${borderColor} bg-[#111827] p-4 rounded overflow-hidden`}>
      <div className={`absolute top-0 left-0 h-full w-0.5 ${accentColor}`} />
      <div className="flex items-center justify-between border-b border-[#263548]/30 pb-2 mb-3">
        <div className="font-mono">
          <h3 className="text-xs font-bold text-white uppercase tracking-wider">{title}</h3>
          {subtitle && <p className="text-[9px] text-[#94A3B8]">{subtitle}</p>}
        </div>
        {badge}
      </div>
      <div className="text-xs text-[#94A3B8] leading-relaxed space-y-2">
        {children}
      </div>
    </div>
  );
}

// Tactical section headers
export function ReportSectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="flex items-center gap-2 border-b border-[#263548] pb-1 my-4 font-mono">
      <span className="h-1.5 w-1.5 rounded-full bg-[#3B82F6] animate-pulse" />
      <span className="text-[10px] font-bold uppercase tracking-widest text-[#06B6D4]">{title}</span>
      {subtitle && <span className="text-[8px] text-[#94A3B8]/60 uppercase ml-auto">({subtitle})</span>}
    </div>
  );
}

// Metadata list block
export function ReportMetaGrid({ items }: { items: { label: string; value: React.ReactNode }[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 font-mono text-[10px]">
      {items.map((item, idx) => (
        <div key={idx} className="border border-[#263548]/30 p-2 bg-[#0B1220] rounded">
          <div className="text-[#94A3B8]/50 uppercase text-[8px]">{item.label}</div>
          <div className="text-white font-semibold truncate mt-0.5">{item.value}</div>
        </div>
      ))}
    </div>
  );
}

// Bounding box threat level badge
export function ThreatLevelBadge({ level }: { level: "low" | "medium" | "high" | "critical" | string }) {
  const styles: Record<string, string> = {
    low: "bg-[#22C55E]/10 border-[#22C55E]/20 text-[#22C55E]",
    medium: "bg-[#3B82F6]/10 border-[#3B82F6]/20 text-[#3B82F6]",
    high: "bg-[#F59E0B]/10 border-[#F59E0B]/20 text-[#F59E0B]",
    critical: "bg-[#EF4444]/10 border-[#EF4444]/20 text-[#EF4444]",
  };
  const label = (level || "low").toUpperCase();
  return (
    <Badge variant="outline" className={`font-mono text-[9px] h-4 py-0 ${styles[level] || styles.low}`}>
      {label}
    </Badge>
  );
}
