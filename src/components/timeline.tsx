import { Newspaper, Radio } from "lucide-react";
import type { TimelineEntry } from "@/utils/timeline";

/**
 * Renders a chronology of real events/news (src/utils/timeline.ts). Every
 * entry links to its real source; there is no synthetic filler entry for an
 * empty or disabled state — `disabledReason`/`error` render as explicit
 * text instead, matching the GIS layer cards' "no data / source error"
 * convention rather than a blank pretend-empty list.
 */
export function Timeline({
  entries,
  disabledReason = null,
  error = null,
  className = "",
}: {
  entries: TimelineEntry[];
  disabledReason?: string | null;
  error?: string | null;
  className?: string;
}) {
  if (disabledReason) {
    return (
      <p className={`text-[10px] leading-relaxed text-console-label ${className}`}>{disabledReason}</p>
    );
  }

  return (
    <div className={`space-y-2 ${className}`}>
      {error && (
        <p className="text-[9px] leading-relaxed text-console-amber">{error}</p>
      )}
      {entries.length === 0 && !error && (
        <p className="text-[10px] leading-relaxed text-console-label">
          No events or news collected in this window.
        </p>
      )}
      {entries.map((entry) => (
        <a
          key={entry.id}
          href={entry.sourceUrl || undefined}
          target="_blank"
          rel="noopener noreferrer"
          className={`block rounded border border-console-border bg-console-deep/60 p-2 transition-colors ${
            entry.sourceUrl ? "hover:border-console-blue/60" : "cursor-default opacity-80"
          }`}
          onClick={(e) => {
            if (!entry.sourceUrl) e.preventDefault();
          }}
        >
          <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-wide text-console-label">
            {entry.kind === "event" ? (
              <Radio className="size-2.5 text-[#A855F7]" />
            ) : (
              <Newspaper className="size-2.5 text-console-blue" />
            )}
            <span>{entry.kind === "event" ? "GDELT event" : "News"}</span>
            <span className="ml-auto font-mono normal-case text-console-muted">
              {entry.timestamp ? new Date(entry.timestamp).toLocaleString() : "date not reported"}
            </span>
          </div>
          <p className="mt-1 text-[11px] font-medium text-console-text">{entry.title}</p>
          <p className="mt-0.5 text-[9px] text-console-muted">{entry.sourceLabel}</p>
          {entry.detail && (
            <p className="mt-1 text-[9px] leading-relaxed text-console-label">{entry.detail}</p>
          )}
        </a>
      ))}
    </div>
  );
}
