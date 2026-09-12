# Beautiful UI

Nineteen open-source UI component patterns for **AI-native interfaces** — loading and thinking states, streaming text, human-in-the-loop approvals, agent task lists, AI-enriched tables, command search, and more. Built with Next.js (App Router), Tailwind CSS v4, and TypeScript. Light and dark mode supported out of the box via CSS design tokens.

## Components

| # | Component | # | Component |
|---|-----------|---|-----------|
| 01 | Loading State | 11 | Diff Table |
| 02 | Thinking | 12 | Records Table |
| 03 | Streaming Text | 13 | Filter Table |
| 04 | Approval Card | 14 | Sidebar Nav |
| 05 | Tool Chips | 15 | Search |
| 06 | Task Rows | 16 | Insight Cards |
| 07 | Chat Composer | 17 | Code Block |
| 08 | Prompt Bar | 18 | Fine-tune Card |
| 09 | Recommendation Card | 19 | Selection Actions |

Each component lives in [components/ui/](components/ui/) as a single self-contained file with inline demo data — copy the file into your project and adapt it.

## Getting started

```bash
npm install
npm run dev
```

Open http://localhost:3000 to browse the showcase.

## Design tokens

Colors, fonts (Inter + JetBrains Mono), and easing curves are defined as CSS variables in [app/globals.css](app/globals.css) and exposed to Tailwind via `@theme inline`. Dark mode follows `prefers-color-scheme` automatically.

## Deploy

One-click deploy to [Vercel](https://vercel.com/new), or any host that supports Next.js.

## Credits & license

Component patterns inspired by [Beautiful UI](https://beautiful-ui-five.vercel.app/) by Turbo Design Studio. All code, copy, and assets in this repository are original work and are **not** affiliated with or endorsed by Turbo Design Studio.

MIT — see [LICENSE](LICENSE).
