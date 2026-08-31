import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders LLM-generated report/brief prose (reportOf, caseSummaryOf,
 * executiveBriefOf and similar in src/utils/llm.ts) as actual formatted
 * markdown instead of a literal string. Those functions are prompted to
 * return markdown — headers, **bold**, and GFM tables in particular
 * (reportOf's key-findings sections routinely come back as pipe tables) —
 * and every call site was previously dumping that string into a `<pre>` or
 * `<p>` verbatim, so an analyst saw literal `**`/`###`/`|---|` characters
 * on screen instead of the structure the model produced.
 *
 * `remark-gfm` specifically for table support — plain react-markdown does
 * not parse GFM tables on its own.
 */
export function MarkdownReport({
  text,
  className = "text-[11px] text-console-text",
}: {
  text: string;
  className?: string;
}) {
  return (
    <div className={`leading-relaxed ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="mt-3 mb-1.5 text-sm font-bold uppercase tracking-wide text-console-text first:mt-0">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mt-3 mb-1.5 text-xs font-bold uppercase tracking-wide text-console-text first:mt-0">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-2.5 mb-1 text-[11px] font-bold uppercase tracking-wide text-console-cyan first:mt-0">
              {children}
            </h3>
          ),
          p: ({ children }) => <p className="mb-2 last:mb-0 text-console-text">{children}</p>,
          strong: ({ children }) => <strong className="font-bold text-console-text">{children}</strong>,
          em: ({ children }) => <em className="italic text-console-text/90 font-medium">{children}</em>,
          ul: ({ children }) => <ul className="mb-2 list-disc space-y-0.5 pl-4 text-console-text">{children}</ul>,
          ol: ({ children }) => <ol className="mb-2 list-decimal space-y-0.5 pl-4 text-console-text">{children}</ol>,
          li: ({ children }) => <li className="text-console-text">{children}</li>,
          hr: () => <hr className="my-3 border-console-border" />,
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-console-blue hover:underline font-medium"
            >
              {children}
            </a>
          ),
          code: ({ children }) => (
            <code className="rounded bg-console-deep px-1.5 py-0.5 font-mono text-[10px] text-console-amber font-semibold">
              {children}
            </code>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-console-cyan/60 pl-2.5 text-console-text italic">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="mb-3 overflow-x-auto rounded border border-console-border shadow-sm">
              <table className="w-full border-collapse text-left">{children}</table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-console-deep font-mono text-[10px] uppercase tracking-wide text-console-cyan font-bold border-b border-console-border">
              {children}
            </thead>
          ),
          tr: ({ children }) => <tr className="border-t border-console-border/70 hover:bg-console-surface/50">{children}</tr>,
          th: ({ children }) => <th className="px-3 py-2 font-bold text-console-text">{children}</th>,
          td: ({ children }) => <td className="px-3 py-2 align-top text-console-text font-normal">{children}</td>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
