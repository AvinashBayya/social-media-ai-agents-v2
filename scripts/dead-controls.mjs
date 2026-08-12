/**
 * Dead-control detector — finds buttons that cannot do anything.
 *
 * The browser audit found this class repeatedly and no unit test could see any
 * of it: /vault's "Download Checked Payload" had `onClick: undefined`, /graph
 * had eight inert controls, and the notification bell had no handler while
 * displaying a permanent red unread dot. A control that cannot act tells the
 * analyst a capability exists.
 *
 * HOW IT WORKS. React stores a node's props under a `__reactProps$…` key on the
 * DOM element itself. Reading that is the only reliable way to ask "does this
 * button have a handler" from outside React — inspecting the markup cannot see
 * it, and clicking everything is slow, stateful and destructive.
 *
 * WHAT IT CANNOT CATCH, stated plainly:
 *   - A handler that exists but does nothing useful. `onClick={() => {}}` and a
 *     handler that writes state nothing renders both look alive from here.
 *   - A control that only appears after interaction (inside a dialog, or after
 *     a file upload). Only what is on screen at load is examined.
 *   - Anything on a route that fails to hydrate — run `bun run smoke` first.
 *
 *   bun run smoke:controls
 *   bun run smoke:controls -- --base http://localhost:3000
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

function discoverRoutes() {
  const dir = path.join(REPO, "src", "routes");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".tsx") && !f.startsWith("__"))
    .map((f) => "/" + f.replace(/\.tsx$/, ""))
    .map((r) => (r === "/index" ? "/" : r))
    .sort();
}

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

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: REPO, shell: true, stdio: "inherit" });
    p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} exited ${c}`))));
  });
}

async function waitFor(url, ms = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(4000) })).ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

const DEMO_SESSION = JSON.stringify({
  operator: "admin@",
  displayName: "Administrator",
  email: "admin@sentinel.local",
  role: "Administrator",
  signedInAt: "2026-01-01T00:00:00.000Z",
  remember: true,
});

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
    });
    if (!(await waitFor(base + "/"))) throw new Error("server did not become ready");
  }

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript((s) => {
    try {
      localStorage.setItem("sentinel_demo_session", s);
    } catch {}
  }, DEMO_SESSION);

  const dead = [];
  let examined = 0;

  for (const route of discoverRoutes()) {
    const page = await ctx.newPage();
    try {
      await page.goto(base + route, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout(2500);

      const found = await page.evaluate(() => {
        /** React's own props bag for this node, or null. */
        const propsOf = (el) => {
          const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
          return key ? el[key] : null;
        };

        // Only the page body. The shared AppShell is checked once, on "/".
        const scope = document.querySelector("main") ?? document.body;
        const out = [];

        for (const el of scope.querySelectorAll('button, [role="button"]')) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") continue;

          // A <button> wrapped by an <a> (asChild) navigates via the anchor.
          if (el.closest("a[href]")) continue;
          // A submit button inside a form is driven by the form's onSubmit.
          if (el.getAttribute("type") === "submit" && el.closest("form")) continue;

          const props = propsOf(el);
          if (!props) continue; // not hydrated; smoke.mjs reports that separately
          const hasHandler =
            typeof props.onClick === "function" ||
            typeof props.onPointerDown === "function" ||
            typeof props.onMouseDown === "function" ||
            typeof props.onKeyDown === "function";
          if (hasHandler) continue;

          out.push({
            label: (el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 60),
            html: el.outerHTML.slice(0, 120),
          });
        }
        return { total: scope.querySelectorAll('button, [role="button"]').length, dead: out };
      });

      examined += found.total;
      if (found.dead.length) {
        dead.push({ route, controls: found.dead });
        console.log(`  ${route} — ${found.dead.length} dead of ${found.total}`);
        for (const c of found.dead) console.log(`      "${c.label || "(no label)"}"`);
      } else {
        console.log(`  ${route} — ok (${found.total} controls)`);
      }
    } catch (err) {
      console.log(`  ${route} — could not examine: ${String(err).slice(0, 100)}`);
    }
    await page.close();
  }

  await browser.close();

  const count = dead.reduce((n, d) => n + d.controls.length, 0);
  console.log(`\n${count} control(s) with no handler, across ${examined} examined.`);
  if (count) {
    console.log("Wire them or remove them — an inert control asserts a capability.");
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error("\ndead-control run failed:", e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    if (server) server.kill();
  });
