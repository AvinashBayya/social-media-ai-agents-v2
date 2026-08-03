import { defineConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";
import viteReact from "@vitejs/plugin-react";

/**
 * Explicit Vite configuration.
 *
 * This previously came from `@lovable.dev/vite-tanstack-config`, which composed
 * the plugin list for us. That package also bundled Lovable-editor integrations
 * (a preview asset proxy, a dev-server bridge, an HMR gate) that this project
 * has no use for, and it defaulted the Nitro preset to cloudflare.
 *
 * Plugin ORDER matters and mirrors what that package produced:
 *   tsConfigPaths -> tailwindcss -> tanstackStart -> nitro -> viteReact
 * Moving viteReact ahead of tanstackStart breaks the SSR transform.
 */
export default defineConfig({
  plugins: [
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
    tailwindcss(),
    tanstackStart({
      // Redirect TanStack Start's bundled server entry to src/server.ts, our SSR
      // error wrapper. nitro builds the server bundle from this.
      server: { entry: "server" },
    }),
    // Deployment target is a plain Node server in a container on Azure Container
    // Apps, so emit .output/server/index.mjs rather than a Cloudflare worker.
    // `preset` sits at the top level — NitroPluginConfig extends NitroConfig.
    // Nesting it under `config` type-errors and is silently ignored, which only
    // appeared to work because node-server is also nitro's default.
    nitro({ preset: "node-server" }),
    viteReact(),
  ],
  resolve: {
    // React and TanStack must resolve to a single copy, or hooks fail at runtime
    // with "invalid hook call" once a transitive dep pulls its own React.
    dedupe: ["react", "react-dom", "@tanstack/react-router", "@tanstack/react-store"],
  },
});
