import { Link } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";

/**
 * "This collector is switched off because a credential is missing."
 *
 * Every module that depends on a credential had its own way of going quiet, and
 * none of them named the credential. A page showing nothing because Reddit
 * returns 403 unauthenticated looks identical to a page showing nothing because
 * the query matched no posts — and an analyst acts differently on each.
 *
 * Two rules this component exists to enforce:
 *
 *  1. A missing credential is NOT a failure and NOT an empty result. It is a
 *     configuration state with one specific remedy, and it says so.
 *  2. The remedy is named twice — the environment variable, which is the durable
 *     path on Container Apps, and the Settings page, which works without a
 *     redeploy but does not survive a replica restart.
 *
 * The collectors already produce this prose in their `SocialUnavailableError`
 * messages. Pass it through as `detail` rather than replacing it with a generic
 * string.
 */
export function CredentialNotice({
  provider,
  envVars,
  unlocks,
  detail,
  stillWorks,
}: {
  /** Human name, e.g. "Bluesky app password". */
  provider: string;
  /** Env vars carrying it, in precedence order. */
  envVars: string[];
  /** What configuring it switches on. Concrete, not aspirational. */
  unlocks: string;
  /** The collector's own message, when one was raised. Rendered verbatim. */
  detail?: string | null;
  /** What still works without it, when anything does. */
  stillWorks?: string;
}) {
  return (
    <div className="rounded border border-[#F59E0B]/30 bg-[#F59E0B]/5 p-3 text-[11px]">
      <div className="flex items-center gap-1.5 font-bold uppercase tracking-wider text-[#F59E0B]">
        <KeyRound className="size-3.5" />
        {provider} not configured
      </div>
      <p className="mt-1.5 leading-relaxed text-[#94A3B8]">
        {unlocks}{" "}
        <strong className="text-[#F59E0B]">
          Nothing is shown here — that is a missing credential, not a finding that nothing matched.
        </strong>
      </p>
      {stillWorks && <p className="mt-1 leading-relaxed text-[#64748B]">{stillWorks}</p>}
      {detail && (
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-[#64748B]">
          {detail}
        </pre>
      )}
      <p className="mt-2 leading-relaxed text-[#64748B]">
        {envVars.length > 0 && (
          <>
            Set{" "}
            {envVars.map((v, i) => (
              <span key={v}>
                {i > 0 && " and "}
                <code className="text-[#06B6D4]">{v}</code>
              </span>
            ))}{" "}
            in the deployment environment (the durable path), or{" "}
          </>
        )}
        add it on{" "}
        <Link to="/settings" className="text-[#3B82F6] hover:underline">
          Settings
        </Link>{" "}
        and press Verify — a vault credential works immediately but does not survive a replica
        restart.
      </p>
    </div>
  );
}
