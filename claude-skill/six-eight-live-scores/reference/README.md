# six-eight-live-scores — reference files

This folder holds the reference material for the `six-eight-live-scores` skill:
a runnable poller module, a real captured 6-8 payload, and this guide. The skill
itself is defined one level up in `../SKILL.md`.

## Importing the skill

This whole folder is a self-contained, importable Claude Code skill. To use it
in your own repo, copy the `six-eight-live-scores` directory (the parent of this
file) into your repo's skills directory:

```
cp -R six-eight-live-scores /path/to/your-repo/.claude/skills/
```

After that, `.claude/skills/six-eight-live-scores/` contains:

- `SKILL.md` — the skill an AI assistant reads to build the integration.
- `reference/poller.js` — the runnable poller and cache.
- `reference/sample_response.json` — a real captured 6-8 payload.
- `reference/README.md` — this file.

The skill depends on nothing outside this folder.

## Running and adapting `poller.js`

`poller.js` is a plain Node module. It needs Node 18 or newer, because it uses
the built-in global `fetch`, and it has zero external dependencies in its core.

Quick smoke test from this folder:

```js
// smoke.js
const { SixEightLiveScores } = require('./poller');

const scores = new SixEightLiveScores({ log: console.log });
scores.start(20000); // poll 6-8 every 20 seconds

// Give it a moment to warm the cache, then read from it.
setTimeout(() => {
  console.log('live games:', scores.getLiveScores().length);
  scores.stop();
}, 3000);
```

```
node smoke.js
```

To serve the cache to your users over HTTP, follow the commented Express example
at the bottom of `poller.js`. The core module stays dependency-free; install
`express` (or your framework of choice) in your own app and read from the same
cache. Your users hit your route; only this one poller ever calls 6-8.

Things you will likely adapt:

- **Cadence** — `start(intervalMs)` defaults to 20s. Use 15-30s while games are
  live, and call `stop()` when none are.
- **Matching** — `matchByTeams(darkName, lightName)` pairs a 6-8 game with a
  game in your app by normalized team names. Feed it your app's two team names.
- **Deep link** — default it to `https://scores.6-8sports.com/`. The exact
  per-game route is an open item to confirm with 6-8; do not invent a path.

## About `sample_response.json`

`sample_response.json` is a **real payload captured from 6-8 production** on
2026-07-17, trimmed for readability (large `players` and `history` arrays are
truncated with `_note` markers, and only one game is kept). It is here so you
can see the exact envelope and field shapes — `pk`, `in_progress`,
`dark_team_score`, `light_team_score`, `dark_team_name`, `light_team_name`, the
avatar URLs, and the `history` buckets — without making a live call. Code your
field access against it, but treat the scores in it as a frozen snapshot, not a
live feed.
