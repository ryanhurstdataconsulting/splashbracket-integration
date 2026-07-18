# 6-8 Sports x Splashbracket Integration Handoff

This folder is the handoff bundle promised to Danny (creator of
[splashbracket.com](https://splashbracket.com)) during the 6-8 Sports x
Splashbracket integration meeting. It contains everything Danny needs to pull
live 6-8 water-polo scores into his app, show a 6-8 badge, and deep-link back
to 6-8 — the mutual-promotion arrangement discussed on the call.

## Recommended approach

1. **Public endpoint only.** The integration uses `GET
   /api/v2/games/output-page/` on `https://api.6-8sports.com`, the same public
   endpoint that powers the public scoreboard at `scores.6-8sports.com`. No
   credentials, API key, JWT, or MD5-hashed password is required, and none
   should be requested as a prerequisite step. This was confirmed by direct
   testing against production, not agreed with 6-8 in advance — see Open items.
2. **Server-side poller + cache.** The reference architecture has Danny's
   backend (Node primary) poll 6-8 on a sane cadence, cache the result, and
   serve his roughly 5,500 users from that cache. This means 6-8's database
   sees one polling client, not thousands of individual browsers — it
   addresses the browser-fanout half of the database-load concern raised in
   the meeting. It does not, on its own, resolve the separate concern that
   6-8's database runs on shared instances with reads and writes not yet
   separated — see Open items.
3. **Per-game deep link, confirmed.**
   `https://scores.6-8sports.com/scoreboard/games/<pk>/play-by-play` renders
   real play-by-play detail for any valid game `pk` — verified live against
   both an in-progress and a finished game. See
   `spec/6-8_Live_Scores_API_Spec.md`, Section 7, for the two build details
   (the `/play-by-play` segment is required; a nonexistent `pk` correctly
   404s).

## Open items

- **No credentials are needed today.** If 6-8 ever moves this endpoint behind
  auth, that would be a breaking change communicated ahead of time; nothing in
  this bundle should be built to assume it's coming.
- **Shared database, reads and writes not yet separated.** 6-8's database runs
  on shared instances, and read/write separation was raised as an open concern
  in the meeting but not yet resolved on 6-8's side. The poller-plus-cache
  pattern above limits Splashbracket to a single polling client; it doesn't by
  itself fix the underlying shared-instance concern, which is 6-8's to
  address.

## What's in this bundle

| Path | What it is |
|---|---|
| `spec/6-8_Live_Scores_API_Spec.md` | The human-readable integration spec: endpoint, query parameters, response fields, polling cadence guidance, and the deep-link open item. |
| `spec/openapi.yaml` | The same contract as a machine-readable OpenAPI 3.1 document, for anyone who prefers to generate a client or import into API tooling. |
| `claude-skill/six-eight-live-scores/` | An importable Claude skill covering this integration, plus a Node poller reference implementation and a real captured sample payload (`reference/sample_response.json`) for testing against realistic data. |
| `email/follow_up_to_danny.md` | The ready-to-send follow-up email summarizing the meeting and pointing Danny to this bundle. |

## Suggested reading order

1. Start with `spec/6-8_Live_Scores_API_Spec.md` for the narrative overview.
2. Reference `spec/openapi.yaml` while building or generating a client.
3. Use `claude-skill/six-eight-live-scores/` for a working poller pattern and
   a real sample payload.
4. Send `email/follow_up_to_danny.md` (or a version of it) once the bundle is
   reviewed.
