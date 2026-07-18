// six-eight-live-scores/reference/poller.js
//
// Server-side poller + in-memory cache for 6-8 Sports public live water-polo
// scores. Drop this on YOUR backend, poll 6-8 once on a sane cadence, and serve
// your users from the cache. That way 6-8's database sees ONE client (this
// poller) instead of thousands of browsers hitting it directly.
//
// Requirements: Node 18+ (uses the built-in global `fetch`). Zero external
// dependencies in this core module. The Express snippet at the bottom is
// commented out so this file stays dependency-free and passes `node --check`.
//
// The endpoint is PUBLIC. No credentials, no Authorization header, no MD5
// password, and no JWT are required or sent.

'use strict';

const DEFAULT_BASE_URL = 'https://api.6-8sports.com';
const IN_PROGRESS_PATH = '/api/v2/games/output-page/';

// Normalize a team name for matching: lowercase, trim, collapse whitespace, and
// strip punctuation. This lets "6-8 Summer Academy: 2026" match "68 summer
// academy 2026" so a game in your app can be paired with a 6-8 game even when
// the two systems spell the name a little differently.
function normalizeTeamName(name) {
  if (name == null) return '';
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ') // drop punctuation (hyphens, colons, etc.)
    .replace(/\s+/g, ' ') // collapse runs of whitespace
    .trim();
}

// Reduce a full 6-8 game record down to just the fields a score badge needs.
// The raw record also carries `players` and `history`, which are large; we
// deliberately skip them here to keep the cache small.
function toCacheEntry(game) {
  return {
    pk: game.pk,
    name: game.name,
    in_progress: game.in_progress,
    dark_team_name: game.dark_team_name,
    dark_team_score: game.dark_team_score,
    light_team_name: game.light_team_name,
    light_team_score: game.light_team_score,
    dark_team_avatar: game.dark_team_avatar,
    light_team_avatar: game.light_team_avatar,
    updatedAt: new Date().toISOString(),
  };
}

class SixEightLiveScores {
  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl]   Override the 6-8 base URL (defaults to prod).
   * @param {number} [options.pageLimit] Page size for the fetch (defaults to 200).
   * @param {number} [options.maxBackoffMs] Cap on the 503 back-off (defaults to 5 min).
   * @param {(msg: string, meta?: object) => void} [options.log] Optional logger.
   */
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    this.pageLimit = options.pageLimit || 200;
    this.maxBackoffMs = options.maxBackoffMs || 5 * 60 * 1000;
    this.log = options.log || (() => {});

    // Cache of live games, keyed by pk (the game UUID).
    this._cache = new Map();
    this._timer = null;
    this._intervalMs = 20000;
    this._running = false;
    // Current back-off delay after a 503. Zero when healthy.
    this._backoffMs = 0;
  }

  // ---- Public read API (all served from cache, never a live fetch) ----------

  // Every live game currently in the cache, as a plain array.
  getLiveScores() {
    return Array.from(this._cache.values());
  }

  // A single game by its 6-8 pk (UUID), or null if it is not live/cached.
  getScoreForGame(pk) {
    return this._cache.get(pk) || null;
  }

  // Find a live 6-8 game by team names. Order-insensitive: it matches whether
  // your app labels the two teams in the same dark/light order 6-8 does or not.
  // Returns the cached entry, or null if no live game matches.
  matchByTeams(darkName, lightName) {
    const a = normalizeTeamName(darkName);
    const b = normalizeTeamName(lightName);
    if (!a && !b) return null;

    for (const entry of this._cache.values()) {
      const d = normalizeTeamName(entry.dark_team_name);
      const l = normalizeTeamName(entry.light_team_name);
      if ((d === a && l === b) || (d === b && l === a)) {
        return entry;
      }
    }
    return null;
  }

  // ---- Lifecycle ------------------------------------------------------------

  // Start polling on a fixed cadence. Recommended cadence while games are live
  // is 15-30s; the default is 20s (a reasonable, DB-friendly middle ground).
  // Poll only while games are actually in progress; stop() when none are live.
  start(intervalMs = 20000) {
    if (this._running) return;
    this._intervalMs = intervalMs;
    this._running = true;

    // Fetch once immediately so the cache is warm, then on the interval.
    this._poll();
    this._scheduleNext();
  }

  stop() {
    this._running = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  _scheduleNext() {
    if (!this._running) return;
    // While backing off after a 503, wait the longer of the two delays so we do
    // not retry-storm a struggling upstream.
    const delay = Math.max(this._intervalMs, this._backoffMs);
    this._timer = setTimeout(() => {
      this._poll().finally(() => this._scheduleNext());
    }, delay);
  }

  // ---- The single upstream call ---------------------------------------------

  async _poll() {
    const url =
      `${this.baseUrl}${IN_PROGRESS_PATH}` +
      `?game_type=in_progress&limit=${this.pageLimit}`;
    // NOTE: do NOT add created_from / created_to / created_at_after here. On 6-8
    // those date filters either return an HTTP 500, an HTTP 400, or are silently
    // ignored. There is no working server-side date filter — narrow by date
    // CLIENT-SIDE, after the fetch, using each game's own timestamp fields.

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });

      // Back off (do not retry-storm) when the load balancer returns a 503.
      if (res.status === 503) {
        this._bumpBackoff();
        this.log('6-8 poller: HTTP 503, backing off', { backoffMs: this._backoffMs });
        return;
      }

      if (!res.ok) {
        // Any other non-2xx: keep the last-known cache, log, and try again next
        // tick. We do not clear the cache on a transient error.
        this.log('6-8 poller: non-OK response', { status: res.status });
        return;
      }

      // Healthy response resets the back-off.
      this._backoffMs = 0;

      const body = await res.json();
      const results = Array.isArray(body.results) ? body.results : [];
      this._replaceCache(results);
      this.log('6-8 poller: cache updated', { liveGames: this._cache.size });
    } catch (err) {
      // Network error, JSON parse failure, etc. Keep the last-known cache.
      this.log('6-8 poller: fetch failed', { error: String(err) });
    }
  }

  _bumpBackoff() {
    // Exponential-ish back-off: start at one interval, double, cap at max.
    const next = this._backoffMs === 0 ? this._intervalMs : this._backoffMs * 2;
    this._backoffMs = Math.min(next, this.maxBackoffMs);
  }

  // Rebuild the cache from a fresh page of in-progress games. Games that are no
  // longer in progress simply drop out, because we replace rather than merge.
  _replaceCache(results) {
    const next = new Map();
    for (const game of results) {
      if (!game || !game.pk) continue;
      // Guard: only cache games the server still marks as in progress.
      if (game.in_progress === false) continue;
      next.set(game.pk, toCacheEntry(game));
    }
    this._cache = next;
  }
}

module.exports = { SixEightLiveScores, normalizeTeamName };

// ---------------------------------------------------------------------------
// Example: serving the cache to your users with Express.
//
// The core above stays dependency-free. To wire it into an HTTP route, install
// express in YOUR app (`npm i express`) and adapt this snippet. Your ~5,500
// users hit YOUR /live-scores route, which reads from the in-memory cache; only
// this one poller process ever calls 6-8.
//
//   const express = require('express');
//   const { SixEightLiveScores } = require('./poller');
//
//   const scores = new SixEightLiveScores({ log: console.log });
//   scores.start(20000); // poll 6-8 every 20 seconds while games are live
//
//   const app = express();
//
//   // All live scores, straight from cache (no upstream call per request).
//   app.get('/live-scores', (req, res) => {
//     res.json({ games: scores.getLiveScores() });
//   });
//
//   // One game by its 6-8 pk (UUID).
//   app.get('/live-scores/:pk', (req, res) => {
//     const game = scores.getScoreForGame(req.params.pk);
//     if (!game) return res.status(404).json({ error: 'not live or not found' });
//     res.json(game);
//   });
//
//   app.listen(3000, () => console.log('serving 6-8 live scores from cache'));
//
//   // Graceful shutdown stops the poller so it does not leak a timer.
//   process.on('SIGTERM', () => scores.stop());
// ---------------------------------------------------------------------------
