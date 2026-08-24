import React from "react";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, ShieldCheck } from "lucide-react";

// Reusable Classified Header / Banner for premium tactical cards
interface ClassifiedHeaderProps {
  level?: "SECRET" | "CONFIDENTIAL" | "UNCLASSIFIED" | string;
  className?: string;
}

export function ClassifiedHeader({ level = "SECRET", className = "" }: ClassifiedHeaderProps) {
  const colorClass = level.includes("SECRET")
    ? "text-red-500 border-red-500/20 bg-red-500/5"
    : level.includes("CONFIDENTIAL")
      ? "text-yellow-500 border-yellow-500/20 bg-yellow-500/5"
      : "text-green-500 border-green-500/20 bg-green-500/5";

  return (
    <div
      className={`flex items-center justify-between border-b border-console-border/40 pb-2 mb-2 font-mono text-[9px] ${className}`}
    >
      <span className="text-console-muted/60 flex items-center gap-1">
        <ShieldCheck className="size-3 text-console-blue" /> CONTROL SYSTEM: OSINT//STRICT
      </span>
      <Badge
        variant="outline"
        className={`${colorClass} text-[8px] font-bold rounded-none h-4 uppercase px-1`}
      >
        UNCLASSIFIED // DEMONSTRATOR
      </Badge>
    </div>
  );
}

// Tactical Panel wrapping standard dashboard elements
interface TacticalPanelProps {
  title: string;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  sideStripColor?: string; // e.g. "bg-console-blue"
}

export function TacticalPanel({
  title,
  icon,
  actions,
  children,
  className = "",
  sideStripColor = "bg-console-border",
}: TacticalPanelProps) {
  return (
    <div
      className={`bg-console-surface border border-console-border rounded relative overflow-hidden font-mono ${className}`}
    >
      <div className={`absolute top-0 left-0 h-full w-0.5 ${sideStripColor}`} />
      <div className="p-3 border-b border-console-border bg-console-deep/20 flex justify-between items-center pb-2">
        <span className="text-[10px] font-bold uppercase tracking-widest text-console-muted flex items-center gap-1.5">
          {icon} {title}
        </span>
        {actions && <div className="flex items-center gap-1.5">{actions}</div>}
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

// Standard Empty State placeholder for tables, charts, or lists
interface EmptyStateProps {
  title?: string;
  message?: string;
  icon?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  title = "No Telemetry Indexed",
  message = "Execute query to pull live coordinates and matches.",
  icon = <AlertTriangle className="size-5 text-console-amber mx-auto mb-1.5" />,
  className = "",
}: EmptyStateProps) {
  return (
    <div
      className={`text-center py-8 text-console-muted/60 bg-console-surface border border-console-border rounded font-mono text-[10px] ${className}`}
    >
      {icon}
      <h4 className="font-bold text-console-text uppercase mt-1">{title}</h4>
      <p className="text-[9px] mt-0.5 text-console-muted/50 max-w-xs mx-auto leading-normal">
        {message}
      </p>
    </div>
  );
}

// Reusable Pulse Skeleton loader cards
interface SkeletonLoaderProps {
  lines?: number;
  className?: string;
}

export function SkeletonLoader({ lines = 3, className = "" }: SkeletonLoaderProps) {
  return (
    <div
      className={`p-4 border border-console-border bg-console-surface rounded animate-pulse space-y-2.5 ${className}`}
    >
      <div className="h-3 w-1/3 bg-console-border rounded" />
      {Array.from({ length: lines }).map((_, idx) => (
        <div key={idx} className="h-2 w-full bg-console-border/60 rounded" />
      ))}
    </div>
  );
}

// Reusable Table row skeletons
interface TableSkeletonProps {
  rows?: number;
  cols?: number;
  className?: string;
}

export function TableSkeleton({ rows = 3, cols = 4, className = "" }: TableSkeletonProps) {
  return (
    <div className={`border border-console-border bg-console-surface rounded animate-pulse ${className}`}>
      <div className="bg-console-deep/40 p-2.5 border-b border-console-border flex justify-between">
        {Array.from({ length: cols }).map((_, idx) => (
          <div key={idx} className="h-2 w-16 bg-console-border rounded" />
        ))}
      </div>
      <div className="p-2 space-y-2.5">
        {Array.from({ length: rows }).map((_, rowIdx) => (
          <div
            key={rowIdx}
            className="flex justify-between pb-1.5 border-b border-console-border/10 last:border-b-0"
          >
            {Array.from({ length: cols }).map((_, colIdx) => (
              <div key={colIdx} className="h-2 w-14 bg-console-border/50 rounded" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
