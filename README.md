<div align="center">

# Acquired

**A little familiar. A little unexpected.**

A taste-guided cultural discovery agent that builds a gradual route from what you already love to something you want to understand.

[Live demo](https://acquired.nini-lab.chatgpt.site/)

Built for the **Qloo Agentic Hackathon 2026**.

</div>

---

## Why Acquired

Recommendations are good at giving you *more of what you already like*. They are less helpful when you want to cross a cultural gap: getting into a band, book, film, game, or other creative territory that feels interesting but still unfamiliar.

Acquired treats discovery as a route instead of a list.

You choose a destination and a few familiar favorites. The agent resolves the exact cultural entities, measures taste relationships with Qloo, and constructs a sequence of intermediate stops that are meant to feel progressively closer to the destination.

## How it works

1. **Choose a destination** — the artist, work, or cultural territory you want to enter.
2. **Anchor the route** — add familiar favorites so the agent has a real taste starting point.
3. **Confirm identities and preferences** — disambiguate catalog entities, keep or remove constraints, and choose 3–10 stops.
4. **Build a measured route** — Acquired uses Qloo search and taste-graph measurements to choose and validate the path.
5. **Walk it** — sample each stop, rate familiarity / unfamiliarity / liking, swap a stop, or rebuild the remaining path when needed.
6. **Keep the journey** — progress, ratings, replacements, and a final reflection can be saved and reopened.

## What Qloo does

Qloo is part of the core routing loop rather than a decorative lookup layer.

Acquired uses Qloo to:

- resolve catalog identities across media;
- measure associations from familiar favorites;
- backtrack from the destination to candidate bridge works;
- validate replacement and reroute candidates;
- surface measured connection evidence when it is available.

When supporting evidence is incomplete, the interface says so instead of inventing an explanation.

## Agent behavior

The route builder includes safeguards for cases that commonly make cultural “entry routes” feel wrong:

- destination works are not recommended early as bridge stops;
- explicit series / sequel ordering is respected when catalog evidence supports it;
- user-selected constraints stay active during reroutes;
- a reroute keeps the already-visited prefix and original destination;
- replacing a stop re-measures the relevant connection;
- partial provider data never gets converted into fabricated certainty.

## Architecture

```text
Browser
  │
  ├─ intake / route preview / walk / reflection
  │
  ▼
ChatGPT Sites server routes
  │
  ├─ visitor identity + ownership
  ├─ request / storage budgets
  ├─ CAS session persistence
  └─ Acquired action layer
        │
        ├─ catalog resolution
        ├─ route construction
        ├─ swap / reroute measurement
        └─ evidence generation
              │
              ▼
             Qloo

Cloudflare D1
  └─ routes, sessions, usage and build locks
```

The Qloo API key and guest-signing secret are server-side runtime secrets and are not included in this repository.

## Stack

- TypeScript
- React / Next.js-compatible Sites runtime
- ChatGPT Sites
- Cloudflare D1 + Drizzle
- Qloo API
- pnpm

## Repository guide

```text
app/acquired/          Product UI and journey flow
app/api/               Server HTTP boundaries
lib/acquired/          Routing, evidence, persistence and safety logic
db/ + drizzle/         D1 schema and migrations
scripts/               Build support and regression tests
worker/                Sites / Cloudflare runtime entry
```

This is a cleaned submission snapshot. Internal development logs, deployment identifiers, historical acceptance archives, credentials, database contents, and private visitor data are intentionally excluded.

## Local development

Install dependencies:

```bash
pnpm install
```

Run the local Sites/Vite development environment:

```bash
pnpm dev
```

The hosted application expects runtime bindings and secrets such as `DB`, `QLOO_API_KEY`, and `ACQUIRED_GUEST_SECRET`. Do not commit real values.

## Selected checks

The project includes regression coverage for route boundaries, destination / series rules, Qloo transport behavior, provider failures, session CAS, visitor isolation, route-library counting, English intent parsing, and responsive UI behavior.

Examples:

```bash
node --experimental-strip-types scripts/test-acquired-walk.mjs
node --experimental-strip-types scripts/test-acquired-telemetry.mjs
node --experimental-strip-types scripts/test-acquired-transport.mjs
node --experimental-strip-types scripts/test-public-release.mjs
node --experimental-strip-types scripts/test-route-library.mjs
node node_modules/typescript/bin/tsc --noEmit
```

These local checks use fixtures or mocked provider responses unless explicitly documented otherwise.

---

<div align="center">

**Don't recommend what I already like. Take me somewhere new, slowly enough that I follow.**

</div>
