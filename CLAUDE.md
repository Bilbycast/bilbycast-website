# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

bilbycast-website is the public documentation + marketing site at **bilbycast.com**. Built with **Astro + Starlight** (docs framework) and Tailwind CSS v4 via `@astrojs/starlight-tailwind`. No backend — static site output to `./dist/`.

## Build & Run Commands

All commands run from this directory:

```bash
npm install          # First-time setup (or after dependency changes)
npm run dev          # Local dev server at http://localhost:4321 (hot reload)
npm run build        # Production build → ./dist/
npm run preview      # Serve ./dist/ locally to sanity-check the production bundle
npm run astro ...    # Underlying Astro CLI (e.g. `npm run astro check`)
```

## Project Structure

```
src/
├── assets/            # Images, icons, other static assets imported by content
├── components/        # Astro components (.astro)
├── content/
│   └── docs/          # MD / MDX content — each file becomes a route
├── content.config.ts  # Starlight content collection config
├── layouts/           # Page layouts (Starlight overrides live here)
├── pages/             # Top-level routes outside the docs collection
└── styles/            # Tailwind + global CSS
public/                # Favicons, robots.txt, other verbatim-served assets
astro.config.mjs       # Astro + Starlight config (sidebar, site URL, integrations)
```

## Content model

- Docs live under `src/content/docs/`. Each `.md` / `.mdx` file is auto-routed by filename.
- Images go in `src/assets/` and are referenced from markdown with relative paths (Astro optimizes them at build).
- Verbatim static assets (favicons, OG images that aren't optimized) go in `public/`.
- Sidebar ordering + navigation is driven by `astro.config.mjs` (Starlight `sidebar` option), not by frontmatter alone.

## When editing

- Prefer MDX only when embedding Astro components; plain MD is enough for most content.
- Run `npm run dev` while editing — Starlight surfaces broken links + frontmatter errors in the terminal.
- Run `npm run build` before declaring work done — Astro's build is stricter than dev (catches type errors in `astro check`, missing images, etc.).
- Tailwind v4 is configured via `@tailwindcss/vite`; no `tailwind.config.js`. Theme tweaks live in `src/styles/` and/or the Starlight config.

## Deployment

Built site (`./dist/`) is deployed to bilbycast.com. Deploy pipeline lives outside this repo — this project only produces the static bundle.
