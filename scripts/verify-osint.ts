/**
 * One-command OSINT verification — `bun run verify:osint`.
 *
 * Executes the real OSINT subsystem end-to-end (planner → collectors →
 * validation → snapshot → resolution → graph/timeline → four disciplines →
 * contradictions/correlations → grounded context → report/PDF → case isolation →
 * passive policy) and prints one consolidated result. Exits non-zero ONLY when a
 * critical check actually fails; live network gaps are reported as
 * UNAVAILABLE/CONFIG_DEPENDENT, never faked to PASS.
 */
import { runOsintVerification, type CheckStatus } from "../src/utils/osint/verification";

const ICON: Record<CheckStatus, string> = {
  LIVE_VERIFIED: "🟢 LIVE",
  DETERMINISTIC_VERIFIED: "🟢 DET",
  CONFIG_DEPENDENT: "🟡 CONFIG",
  UNAVAILABLE: "⚪ UNAVAIL",
  FAILED: "🔴 FAIL",
};

const live = !process.argv.includes("--offline");
const report = await runOsintVerification({ live });

console.log(`\n════════ OSINT E2E VERIFICATION ════════  (live=${live})\n`);
for (const c of report.checks) {
  const tag = ICON[c.status] + (c.critical && c.status === "FAILED" ? " *CRITICAL*" : "");
  console.log(`${tag.padEnd(20)} ${c.label}`);
  console.log(`  ${c.detail}`);
}
console.log("\n──────── SUMMARY ────────");
console.log(
  `live:${report.counts.LIVE_VERIFIED}  deterministic:${report.counts.DETERMINISTIC_VERIFIED}  ` +
    `config:${report.counts.CONFIG_DEPENDENT}  unavailable:${report.counts.UNAVAILABLE}  failed:${report.counts.FAILED}`,
);
console.log(`\nOVERALL: ${report.overall}\n`);

const criticalFailed = report.checks.some((c) => c.critical && c.status === "FAILED");
process.exit(criticalFailed ? 1 : 0);
