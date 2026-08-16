import { networkInterfaces } from "node:os";
import vinext from "vinext";
import { defineConfig } from "vite";
// Names of the Cloudflare bindings the worker expects. Kept in a file rather
// than inline because the deployment platform generates it; set either to null
// to build without that binding.
import hostingConfig from "./hosting.json";
import { sites } from "./build/sites-vite-plugin";
import { localWorkbench } from "./build/local-workbench-plugin";
import "./scripts/sync-case-library.mjs";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

/**
 * Every address this machine answers on, so requests to ourselves never leave
 * the box. A page served over the LAN or over Tailscale arrives with that
 * address in the Host header, and Miniflare re-dispatches the request to the
 * same host to run it inside workerd. With HTTP_PROXY set (a local Clash-style
 * proxy is the normal setup here) and NO_PROXY listing only localhost, that
 * internal hop is handed to the proxy, which cannot route back to a private or
 * tailnet address — the browser gets a 502 that has nothing to do with the app.
 * Listing our own addresses in NO_PROXY keeps the hop local.
 *
 * Note this only fixes the dev server's own process. A proxy running on the
 * client machine has to bypass these ranges too; see scripts/Open-FirewallPorts.ps1
 * and the README for the recommended bypass list.
 */
function selfAddresses() {
  const addresses = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4") addresses.add(entry.address);
    }
  }
  return [...addresses];
}

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Must happen before the Cloudflare plugin is imported: Wrangler reads the
  // proxy environment once, at import time.
  if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.https_proxy) {
    const existing = (process.env.NO_PROXY || process.env.no_proxy || "").split(",").map((item) => item.trim()).filter(Boolean);
    const merged = [...new Set([...existing, ...selfAddresses()])].join(",");
    process.env.NO_PROXY = merged;
    process.env.no_proxy = merged;
  }

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      localWorkbench(),
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
