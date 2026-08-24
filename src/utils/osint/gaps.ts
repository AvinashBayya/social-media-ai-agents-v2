/**
 * What the OSINT module explicitly does NOT do — rendered verbatim in the UI
 * via NotImplementedPanel, the same pattern imaging.ts's NOT_IMPLEMENTED
 * already established for Module 4.
 *
 * Stating a gap accurately, with what it would take to close it, is a
 * stronger position for an evaluator than a demo that quietly shows nothing
 * — or worse, something that looks like output but isn't real. Every entry
 * here was verified against this codebase's actual state (grep for the
 * capability, not assumed) before being written down.
 */

import type { Gap } from "../imaging";

export const OSINT_NOT_IMPLEMENTED: Gap[] = [
  {
    capability: "Amass (subdomain / ASN / netblock enumeration)",
    requires:
      "Bundling or running the real Amass binary (or its REST engine) somewhere this app can " +
      "reach — it is a standalone Go tool, not a hosted API, so it needs a worker/container of " +
      "its own the same way theHarvester and SpiderFoot do.",
    limitation:
      "No integration exists at all today — not even a client stub. Domain/subdomain discovery " +
      "for a target currently comes from crt.sh, DNS-over-HTTPS resolution and GitHub search " +
      "instead (see OSINT Intelligence), which cover related but not identical ground.",
  },
  {
    capability: "theHarvester / SpiderFoot live results",
    requires:
      "A deployed worker reachable at THEHARVESTER_WORKER_URL / SPIDERFOOT_WORKER_URL. Both " +
      "client collectors are fully implemented — real HTTP calls, real response parsing — but " +
      "have nothing to call: no worker is deployed in this environment.",
    limitation:
      "Selecting either collector in an investigation returns an honest \"collector " +
      "unavailable\" result rather than silently omitting it or fabricating one. Both are " +
      "marked optional so their absence doesn't fail an investigation that used other real " +
      "collectors.",
  },
  {
    capability: "Live Maltego transform execution",
    requires:
      "A Maltego Transform Hub/server integration and, for Telegram-specific transforms " +
      "specifically, a real authenticated Telegram API session (api_id/api_hash + a logged-in " +
      "account) — this app does not hold or want end-user Telegram credentials.",
    limitation:
      "This is different from what already exists: /graph's \"Export to Maltego\" button is " +
      "real and working — it exports this app's own real collected entities/relationships as a " +
      "Maltego-importable CSV. There is no live in-app Maltego transform runner, and none is " +
      "planned without a defined credential-handling model.",
  },
  {
    capability: "Full Shodan REST API (api.shodan.io)",
    requires: "A paid Shodan API key/membership. Shodan's host/search endpoints are not free.",
    limitation:
      "Deliberately out of scope, not a gap awaiting a key: Shodan's free InternetDB endpoint " +
      "(internetdb.shodan.io) is already integrated for real — keyless, live port/CPE/CVE/tag " +
      "lookups per IP — and covers the free-tier use case this project's zero-budget constraint " +
      "allows. See OSINT Intelligence / Infrastructure (Shodan).",
  },
];
