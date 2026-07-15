// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

import cloudflare from "@astrojs/cloudflare";

// TODO: replace `site` with your real domain before deploying.
// It is used for absolute URLs in the sitemap and RSS feed.
export default defineConfig({
  site: 'https://example.com',
  integrations: [sitemap()],
  adapter: cloudflare()
});