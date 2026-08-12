/**
 * Route smoke test — every route loads, HYDRATES, and reports no errors.
 *
 * WHY THIS EXISTS. A six-agent browser audit on 2026-08-12 found fourteen live
 * fabrications, eight dead controls and a whole route rendering 178 characters,
 * none of which any of the 642 unit tests could see — because none of them
 * render a page. That gap is the finding this script closes.
 *
 * HYDRATION IS THE LOAD-BEARING CHECK. Mid-audit the dev server began serving
 * SSR HTML that referenced the previous build's asset hashes while every
 * /assets/*.js returned 500. `curl` saw a healthy 200 with full markup and the
 * pages were completely dead in a browser: no handlers, no sockets, no data
 * fetching. Four agents wasted hours on it. A status-code check would not have
 * caught it; asking whether React actually attached does.
 *
 * Deliberately FAST and shallow — this is the every-commit gate. It does not
 * click anything. `bun run smoke:controls` is the deeper pass.
 *
 *   bun run smoke                 # build + boot + check every route
 *   bun run smoke -- --base URL   # check a running server instead
 */

import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const baseArg = argv.includes("--base") ? argv[argv.indexOf("--base") + 1] : null;

/**
 * Routes, discovered from the filesystem rather than hardcoded.
 *
 * A hardcoded list silently stops covering new routes, which is exactly how an
 * untested page reaches a demo.
 */
function discoverRoutes() {
  const dir = path.join(REPO, "src", "routes");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".tsx") && !f.startsWith("__"))
    .map((f) => "/" + f.replace(/\.tsx$/, ""))
    .map((r) => (r === "/index" ? "/" : r))
    .sort();
}

/** An OS-assigned free port, so this never collides with a dev server. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: REPO, shell: true, stdio: "inherit", ...opts });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function waitFor(url, ms = 90_000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (r.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/**
 * The route gate is a client-side localStorage check, so seeding a session is
 * exactly what a signed-in operator has. It protects nothing — see
 * src/utils/demo-session.ts, which says so itself.
 */
const DEMO_SESSION = JSON.stringify({
  operator: "admin@",
  displayName: "Administrator",
  email: "admin@sentinel.local",
  role: "Administrator",
  signedInAt: "2026-01-01T00:00:00.000Z",
  remember: true,
});

/** Console noise that is not a defect in this app. */
const IGNORED = [
  /Download the React DevTools/i,
  /React Router Future Flag/i,
  // Library-internal parameter warnings from tesseract's own core.
  /Parameter not found:/i,
];

let server = null;

async function main() {
  let base = baseArg;

  if (!base) {
    console.log("• building");
    await run("bun", ["run", "build"]);
    const port = await freePort();
    base = `http://localhost:${port}`;
    console.log(`• booting .output on ${port}`);
    server = spawn("node", [".output/server/index.mjs"], {
      cwd: REPO,
      env: { ...process.env, PORT: String(port) },
      stdio: "ignore",
      shell: false,
    });
    if (!(await waitFor(base + "/"))) throw new Error("server did not become ready");
  }

  const routes = discoverRoutes();
  console.log(`• checking ${routes.length} routes against ${base}\n`);

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript((s) => {
    try {
      localStorage.setItem("sentinel_demo_session", s);
    } catch {}
  }, DEMO_SESSION);

  const failures = [];

  for (const route of routes) {
    const page = await ctx.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    const badAssets = [];

    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const t = m.text();
      if (IGNORED.some((re) => re.test(t))) return;
      consoleErrors.push(t.slice(0, 200));
    });
    page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));
    page.on("response", (r) => {
      // The stale-asset outage: SSR fine, every chunk 500.
      if (/\/assets\/.*\.(js|css)$/.test(r.url()) && r.status() >= 400) {
        badAssets.push(`${r.status()} ${r.url().split("/").pop()}`);
      }
    });

    const problems = [];
    try {
      const resp = await page.goto(base + route, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      const status = resp?.status() ?? 0;
      if (status !== 200) problems.push(`HTTP ${status}`);

      await page.waitForTimeout(2500);

      /*
       * HYDRATION. React attaches its own `__react*` keys to the DOM nodes it
       * owns, and only after hydration runs — so this is true iff the client
       * bundle loaded and executed. Checking for rendered markup instead would
       * have passed straight through the stale-asset outage.
       */
      const hydrated = await page.evaluate(() => {
        const nodes = document.querySelectorAll("button, a[href], input");
        for (const el of nodes) {
          if (Object.keys(el).some((k) => k.startsWith("__react"))) return true;
        }
        return false;
      });
      if (!hydrated) problems.push("did not hydrate (no React props on any control)");

      const finalPath = new URL(page.url()).pathname;
      if (finalPath === "/login" && route !== "/login") {
        problems.push(`redirected to /login (gate rejected the seeded session)`);
      }

      if (badAssets.length) problems.push(`asset failures: ${badAssets.slice(0, 3).join(", ")}`);
      if (pageErrors.length) problems.push(`page error: ${pageErrors[0]}`);
      if (consoleErrors.length) problems.push(`console error: ${consoleErrors[0]}`);
    } catch (err) {
      problems.push(`threw: ${String(err).slice(0, 160)}`);
    }

    if (problems.length) {
      failures.push({ route, problems });
      console.log(`  FAIL ${route}`);
      for (const p of problems) console.log(`       ${p}`);
    } else {
      console.log(`  ok   ${route}`);
    }
    await page.close();
  }

  await browser.close();

  console.log(`\n${routes.length - failures.length}/${routes.length} routes healthy`);
  if (failures.length) {
    console.log(`\n${failures.length} route(s) failed:`);
    for (const f of failures) console.log(`  ${f.route}: ${f.problems.join(" | ")}`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error("\nsmoke run failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    if (server) server.kill();
  });
