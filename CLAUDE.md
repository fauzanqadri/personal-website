# CLAUDE.md — personal-website/

Fauzan's personal consultant website: a static site to position him for independent software-engineering project work. Three sections: Blog (tech writing), Work (anonymized case studies), CV (about and experience).

## Stack

- **Astro 5** (static output, built on Vite), **TypeScript strict**, **pnpm**.
- Plain CSS with custom-property design tokens in `src/styles/global.css`. No Tailwind, matching the rest of relay.
- Content lives in markdown under `src/content/`, driven by Astro content collections (the `glob` loader). Schemas are in `src/content.config.ts`.
- `@astrojs/sitemap` and `@astrojs/rss` for sitemap and feed.

## Commands

```bash
pnpm install
pnpm dev       # http://localhost:4321
pnpm build     # static output to dist/
pnpm preview   # serve the built dist/
pnpm check     # astro check (TypeScript + content schema)
```

## Layout

| Path | Purpose |
|------|---------|
| `src/data/site.ts` | Name, role, tagline, contact email, social handles, nav. Edit the `TODO` values before deploying. |
| `src/content.config.ts` | Zod schemas for the `blog` and `work` collections. |
| `src/content/blog/` | Blog posts (one markdown file per post). |
| `src/content/work/` | Case studies (one markdown file per engagement). |
| `src/layouts/` | `BaseLayout` (HTML shell, SEO meta), `BlogPost`, `WorkCase`. |
| `src/components/` | `Header`, `Footer`, `Hero`, `PostCard`, `WorkCard`. |
| `src/pages/` | Routes: home, `/work`, `/blog`, `/cv`, `/rss.xml`, `404`. |
| `src/styles/global.css` | Design tokens, typography, components, dark mode, print styles. |

## Conventions

- **Confidentiality.** This site is public. The CV names past and current employers (Amartha, Gojek, Midtrans), matching the public LinkedIn profile. Blog posts and case studies stay company-neutral ("a fintech lending platform") and carry no internal identifiers: no internal service or topic names, no table names, no PR or ticket links (PL-xxxx), no `relay/` paths, no personal phone number. Present work as anonymized case studies (problem, role, approach, outcome). Keep only generic technical lessons and verifiable engineering numbers. This is the same rule the rest of relay applies to outward syncs, but stricter because this is public.
- **No fabricated CV data.** The CV uses only facts verifiable from real work. Employment history, titles, dates, contact email, and social handles are visible placeholders (the `.placeholder` CSS class) until Fauzan fills them in. Never invent a metric, title, or date.
- **Writing rules.** All page prose and blog posts follow the `writing-rules` skill (no em dash, no contractions, no slop words). Run the audit when drafting new copy.

## Adding content

- **New blog post:** add `src/content/blog/<slug>.md` with frontmatter `title`, `description`, `pubDate`, `tags`, `draft`. It appears on `/blog` and in the feed automatically once `draft` is false.
- **New case study:** add `src/content/work/<slug>.md` with frontmatter `title`, `summary`, `role`, `stack`, `outcome`, `featured`, `order`. Set `featured: true` to surface it on the home page.

## Deploy

`pnpm build` produces a static `dist/` that serves on any static host (Cloudflare Pages, Vercel, Netlify, GitHub Pages). No host is wired in yet. Set the real domain in `astro.config.mjs` (`site`) and in `src/data/site.ts` (`url`) before the first deploy.
