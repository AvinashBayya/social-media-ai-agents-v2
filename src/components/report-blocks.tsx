import React from "react";
import {
  ShieldAlert,
  Compass,
  Sparkles,
  MapPin,
  RefreshCw,
  AlertTriangle,
  FileText,
  ClipboardList,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

// Tactical container block
export function ReportBlock({
  title,
  subtitle,
  children,
  badge,
  borderColor = "border-console-border",
  accentColor = "bg-console-blue",
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  badge?: React.ReactNode;
  borderColor?: string;
  accentColor?: string;
}) {
  return (
    <div className={`relative border ${borderColor} bg-console-surface p-4 rounded overflow-hidden`}>
      <div className={`absolute top-0 left-0 h-full w-0.5 ${accentColor}`} />
      <div className="flex items-center justify-between border-b border-console-border/30 pb-2 mb-3">
        <div className="font-mono">
          <h3 className="text-xs font-bold text-console-text uppercase tracking-wider">{title}</h3>
          {subtitle && <p className="text-[9px] text-console-muted">{subtitle}</p>}
        </div>
        {badge}
      </div>
      <div className="text-xs text-console-muted leading-relaxed space-y-2">{children}</div>
    </div>
  );
}

// Tactical section headers
export function ReportSectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="flex items-center gap-2 border-b border-console-border pb-1 my-4 font-mono">
      <span className="h-1.5 w-1.5 rounded-full bg-console-blue animate-pulse" />
      <span className="text-[10px] font-bold uppercase tracking-widest text-console-cyan">
        {title}
      </span>
      {subtitle && (
        <span className="text-[8px] text-console-muted/60 uppercase ml-auto">({subtitle})</span>
      )}
    </div>
  );
}

// Metadata list block
export function ReportMetaGrid({ items }: { items: { label: string; value: React.ReactNode }[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 font-mono text-[10px]">
      {items.map((item, idx) => (
        <div key={idx} className="border border-console-border/30 p-2 bg-console-deep rounded">
          <div className="text-console-muted/50 uppercase text-[8px]">{item.label}</div>
          <div className="text-console-text font-semibold truncate mt-0.5">{item.value}</div>
        </div>
      ))}
    </div>
  );
}

// Bounding box threat level badge
export function ThreatLevelBadge({
  level,
}: {
  level: "low" | "medium" | "high" | "critical" | string;
}) {
  const styles: Record<string, string> = {
    low: "bg-console-live/10 border-console-live/20 text-console-live",
    medium: "bg-console-blue/10 border-console-blue/20 text-console-blue",
    high: "bg-console-amber/10 border-console-amber/20 text-console-amber",
    critical: "bg-console-red/10 border-console-red/20 text-console-red",
  };
  const label = (level || "low").toUpperCase();
  return (
    <Badge
      variant="outline"
      className={`font-mono text-[9px] h-4 py-0 ${styles[level] || styles.low}`}
    >
      {label}
    </Badge>
  );
}
