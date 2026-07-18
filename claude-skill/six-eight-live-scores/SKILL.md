---
name: six-eight-live-scores
description: Use when integrating 6-8 Sports public live water-polo scores into a backend app — building a server-side poller and short-TTL cache against the public output-page endpoint, matching a 6-8 game to a local game by normalized team names, and rendering an inline 6-8 score badge with a deep link back to 6-8.
---

# six-eight-live-scores

## What this skill builds

An integration that shows 6-8 Sports' live water-polo scores inline in a host
app (for example, a scheduling app), with a 6-8 badge and a deep link back to
6-8 for the full play-by-play. The design goal, agreed with 6-8, is to protect
6-8's database: the host app runs ONE server-side poller against 6-8 and serves
all of its own users from a cache, so 6-8 sees a single client rather than
thousands of browsers.

The reference implementation lives beside this file:

- `reference/poller.js` — a runnable, dependency-free Node 18+ poller and cache.
- `reference/sample_response.json` — a real captured 6-8 payload (trimmed) to
  code against.

## The public endpoint contract

- Base URL: `https://api.6-8sports.com`
- Endpoint: `GET /api/v2/games/output-page/`
- It is **public**. No credentials are required — no `Authorization` header, no
  MD5-hashed password, and no JWT. Send no auth headers at all. This is the same
  endpoint that powers the public scoreboard at `https://scores.6-8sports.com`.

### Working query parameters

- `game_type` — one of `in_progress`, `finished`, or `upcoming`. For live
  scores, always use `in_progress`.
- `limit` — page size (integer).
- `offset` — pagination offset (integer).

The response is a paginated envelope:

```json
{ "count": 153, "next": <object|null>, "previous": <object|null>, "results": [ /* games */ ] }
```

`next`/`previous` are `{ "limit": ..., "offset": ... }` objects (or `null`), not URLs. **Known 6-8 bug:** `previous` mirrors `next`'s forward offset instead of pointing backward — track `offset` client-side instead of trusting it.

### Fields a score badge needs (each element of `results`)

- `pk` — string UUID; the game ID. Use it as the cache key and the deep-link ID.
- `name` — the game name (the source may truncate it).
- `in_progress` — boolean; `true` means the game is live right now.
- `dark_team_name` / `light_team_name` — water polo teams are **dark** and
  **light** (cap colors), not home and away.
- `dark_team_score` / `light_team_score` — the live score.
- `dark_team_avatar` / `light_team_avatar` — team logo URLs.

The full record also carries `players` (roster and per-player stats) and
`history` (play-by-play buckets). Both are large. Skip them for a badge; they
are the "deeper detail" that justifies sending the user to 6-8 via the deep
link.

## Pitfalls — only two date params actually filter

Verified against production:

- `created_from` / `created_to` (ISO date, for example `2026-06-01`, or a full
  ISO date-time) **correctly narrow the result set** server-side. A malformed
  value returns HTTP 400.
- `created_at_after`, `start_date`, `schedule_date_after` → return HTTP 200 but
  are **silently ignored** (the count is identical to the unfiltered result).
  Never rely on these.

For a live-score badge this rarely matters: poll `game_type=in_progress`
directly rather than reaching for a date filter. The `in_progress` set is
small and cheap (roughly 150 games at probe time, versus about 18,600
finished), so poll the in-progress set directly rather than paging the full
history. If you do need a date-bounded historical query, use
`created_from`/`created_to` server-side.

## The server-side poller and cache pattern (and why)

Poll 6-8 from the host backend, cache the trimmed result, and fan out to end
users from that cache. One process talks to 6-8; every user request is served
locally. This is the central agreement with 6-8: their database, currently on
shared instances, must not take direct load from a large browser fleet.

`reference/poller.js` implements this with zero external dependencies:

- Polls `GET /api/v2/games/output-page/?game_type=in_progress` on a configurable
  interval.
- Keeps an in-memory `Map` cache keyed by `pk`, holding only the badge fields
  plus an `updatedAt` timestamp.
- Exposes `getLiveScores()`, `getScoreForGame(pk)`, and
  `matchByTeams(darkName, lightName)`, all served from the cache — never a live
  fetch per user request.
- `start(intervalMs)` / `stop()` control the lifecycle. Poll only while games
  are live; stop when none are.
- Backs off on an HTTP 503 from the load balancer instead of retry-storming, and
  keeps the last-known cache on any transient error.

### Cadence and etiquette

- Recommended cadence: poll `game_type=in_progress` every **15-30s while games
  are live**, and poll nothing when none are live. The exact interval is the
  integrator's call.
- Back off on a `503`; do not retry-storm.
- There is no ETag or conditional-GET guarantee, so rely on the local cache and
  a short TTL rather than server-side revalidation.

## Matching a 6-8 game to a game in the host app

The host app will not have 6-8 team UUIDs at first, so match on team names:

- **v1 (start here):** normalize `dark_team_name` and `light_team_name`
  (lowercase, trim, collapse whitespace, strip punctuation) and compare against
  the host app's two team names. `matchByTeams()` in `reference/poller.js` does
  this and is order-insensitive, so it matches regardless of which side each
  system calls dark or light. Add `schedule_date` to the comparison when it is
  present to disambiguate a rematch.
- **v2 (optional, more robust):** look up each team's UUID directly with the
  public, unauthenticated search endpoint `GET
  /api/v2/global-search/teams/?name=<term>` (`name` is **required** — omitting
  it returns HTTP 500, not an empty result; the match is a case-insensitive
  substring search). Each result's `pk` is the same UUID that appears as
  `dark_team_id` / `light_team_id` on a game record. Team names are not
  guaranteed unique, so confirm the right `pk` per team once rather than
  auto-selecting the first match, then store it and match future games on
  `dark_team_id` / `light_team_id` instead of names. Note:
  `/api/v2/teams/output-page/` is a different, similarly-named endpoint that
  requires authentication (HTTP 401) — it is not a substitute for
  `global-search/teams`.

### Tying a team page to its games (no server-side team filter)

**Verified against production: `output-page` has no team filter.** `team_id`,
`dark_team_id`, `light_team_id`, `team`, `dark_team`, `light_team`, and
`teams` were all tested as query params — every one is silently ignored
(same no-op pattern as the date-filter pitfall above), so there is no
"give me all games for team X" call to make server-side.

To reliably tie a per-team page to that team's games: look up the team's
UUID once via `global-search/teams` (above) and store it, then for each
game record check whether it equals `dark_team_id` or `light_team_id` —
that client-side UUID match is what ties a game to the team page, and the
matching game's own `pk` is the ID to use for its deep link. This is cheap
against `game_type=in_progress` (~150 games); matching against the full
`finished` history (~18,600 games) means paginating that whole set, so
scope it to what the team page actually needs.

## The UI: badge and deep link back to 6-8

- Show a 6-8 logo/badge next to any game that has a live score in the cache.
  Make it expandable to reveal the inline score (dark score, light score, and
  team names) pulled from the cached entry.
- Include a deep link to 6-8 for the full scoring detail — this is the
  mutual-promotion benefit both sides agreed to.
- **The per-game deep link is confirmed:**
  `https://scores.6-8sports.com/scoreboard/games/<pk>/play-by-play`, built
  from the game's `pk`. Verified live against both an in-progress and a
  finished game — real team names, scores, and play-by-play events render
  correctly, not a generic app shell. The `/play-by-play` segment is required
  (dropping it shows only the score header, with no detail loaded); a
  nonexistent `pk` correctly 404s, so it's safe to build this URL directly
  with no pre-check. Content loads asynchronously — allow a couple of
  seconds before treating a blank render as broken.

## Build checklist

- [ ] Poller calls the public `output-page` endpoint with `game_type=in_progress`
      and no auth headers.
- [ ] If a date filter is needed, only `created_from` / `created_to` are used
      (the other date params are silently ignored server-side).
- [ ] End users are served from the cache; only the poller calls 6-8.
- [ ] The poller backs off on a 503 and does not clear the cache on a transient
      error.
- [ ] Team-name matching is normalized and order-insensitive.
- [ ] The badge is present, and the deep link uses the confirmed per-game
      route (`.../scoreboard/games/<pk>/play-by-play`), not the scoreboard root.
