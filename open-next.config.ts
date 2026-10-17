import { defineCloudflareConfig } from "@opennextjs/cloudflare";

/**
 * OpenNext configuration for Cloudflare Workers.
 *
 * `nodejs_compat` is enabled in wrangler.jsonc, which is what makes
 * `node:crypto`'s scrypt and the `crypto` module available to Henna's password
 * hashing and AES-256-GCM code on Workers.
 */
export default defineCloudflareConfig({
  // Henna reads Cloudflare bindings (Hyperdrive) through the environment,
  // injected here so `getDb()` can pick the right connection path.
  cloudflare: {
    // Nothing is cached: every Henna response is user-specific.
    cache: false,
  },
});
