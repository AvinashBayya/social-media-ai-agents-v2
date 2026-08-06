import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { EnvConfigurationError, parseAuthEnv } from "./server/env";

/**
 * Configuration check, run when this module is first loaded — which Nitro does
 * lazily, so in practice it fires on the first request rather than at listen
 * time. Still far earlier than the alternative.
 *
 * Without it the process starts happily, serves pages, and only reveals that
 * DATABASE_URL or SESSION_SECRET is missing when someone first tries to sign
 * in — by which point the failure looks like a broken login rather than a
 * misconfigured deployment. Note that `vite dev` loads .env automatically but
 * the built server does not, which is exactly how that gap appears in
 * production; `bun run start` passes --env-file-if-exists to close it.
 *
 * Deliberately does not throw. The server stays up so it can still render the
 * error page and be diagnosed remotely; refusing to boot on an intranet box
 * with no console attached would be harder to recover from, not safer — every
 * route is gated behind guards that fail closed regardless.
 */
function reportEnvironmentProblems(): void {
  try {
    parseAuthEnv(process.env);
  } catch (error) {
    if (error instanceof EnvConfigurationError) {
      console.error(
        [
          "",
          "  ┌─ Sentinel AI — authentication is NOT configured ─────────────",
          ...error.issues.map((issue) => `  │  ✗ ${issue}`),
          "  │",
          "  │  Sign-in will fail until these are set. Copy .env.example to",
          "  │  .env and fill it in, then restart.",
          "  └──────────────────────────────────────────────────────────────",
          "",
        ].join("\n"),
      );
      return;
    }
    console.error("Unexpected error while validating the environment:", error);
  }
}

reportEnvironmentProblems();

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
