# wow-armory-api

Single endpoint: `GET /api/get-simc`

A background worker continuously works through every historical pull for each tracked guild (`echo`, `liquid`, `method`) across their entire current raid tier — every boss, including farm/reclear pulls on already-killed ones — oldest pull first, and permanently records each pull's sim result. `sim=true` with no other params reads that growing history instantly. `sim=true` with a full param set instead runs a fresh one-off sim right now for whatever specific pull you ask for, preempting the background worker.

## Background worker (Mode 1)

For each tracked guild: enumerate every boss in the raid tier (via raider.io's world raid-rankings — `lib/guilds.js`'s `raid`/`difficulty` config), fetch every pull ever recorded on each boss, merge and sort them chronologically, and sim whichever isn't simmed yet, oldest first — round-robining across the 3 guilds so all of them make steady progress. Every pull's result (per-player DPS, Augmentation Evoker contributions if any) is kept permanently in that guild's history.

Iterations scale down as the backlog grows, since a guild often starts with hundreds-to-thousands of un-simmed historical pulls: `iterations = 600` while backlog ≤ 3, otherwise `clamp(round(600 / 2^(backlog-3)), 15, 600)` — recomputed before every pull, so it ramps back up as the backlog drains and back down if new pulls arrive faster than they're processed. No HTML report is generated for these (would be tens of GB at this volume) — only raw DPS numbers are recorded.

If an on-demand request (Mode 2) comes in, whatever pull the worker is mid-sim on is cancelled immediately and retried whole (not partially recorded) once the worker gets back to it.

Some historical pulls are permanently unsimmable (e.g. a talent-loadout hash from months ago that's incompatible with the current SimC build's talent tree data) — these failures are deterministic, so there's no retry: one failure and it's recorded with `failed: true` (and no player data) instead of being retried forever, so one bad pull can't stall a guild's whole backlog.

## `sim=true`, cached mode (no other params)

`GET /api/get-simc?sim=true` (or `simc=true`, `sim=1`, `simc=1`, `format=html`) — no other query params required. Optional `&limit=N` caps how many history entries come back per guild (omit for everything currently retained, up to `SIMC_MAX_HISTORY_PER_GUILD`, default 2000/guild). Always returns every tracked guild at once:

```json
{
  "guilds": {
    "echo": {
      "raid": "tier-mn-1", "difficulty": "mythic",
      "backlog": 1423, "currentIterations": 200,
      "lastSimmedAt": "2026-08-02T10:15:00.000Z", "lastActivityAt": "2026-08-02T10:15:03.000Z", "manifestLastRefreshed": "2026-08-02T09:00:00.000Z",
      "history": [
        {
          "pullId": "10370461", "boss": "midnight-falls", "pullStartedAt": "...", "simmedAt": "...",
          "iterations": 200, "totalDps": 12345678, "playerCount": 18,
          "players": [{ "name": "...", "realm": "...", "class": "...", "spec": "...", "ilevel": 675, "dps": 654321 }],
          "evokers": [{ "name": "...", "contribution": 12345 }]
        }
      ]
    },
    "liquid": { ... },
    "method": { ... }
  }
}
```

`history` is newest-first. `evokers` is always an array — `[]` if that pull's roster had no Augmentation Evoker. `lastSimmedAt` only updates on a real successful sim; `lastActivityAt` updates on skips too (a guild grinding through a stretch of unsimmable pulls should still read as active, not stalled). A guild that hasn't simmed a single pull yet reads as `backlog: 0, history: []` rather than erroring (its manifest hasn't been fetched yet — check back shortly).

`report=<id>` still works for fetching a previously-generated HTML report by id, but Mode 1 no longer generates one for every pull — only Mode 2 (on-demand) requests produce a real report now.

## `sim=true`, on-demand mode (full param set)

`GET /api/get-simc?sim=true&raid=...&boss=...&difficulty=...&region=...&realm=...&guild=...` — pass the full param set and it runs a fresh sim right now for exactly the pull you describe. Not limited to a guild's currently-tracked raid/boss — any raid/boss/difficulty/region/realm combination works, and `pullId`/`period` can target a specific historical pull.

This **preempts the background worker**: if it's mid-sim on a pull when the request comes in, that pull is cancelled immediately (not partially recorded — it's retried whole once the worker resumes) so the on-demand sim doesn't wait behind it.

| Param | Example | Notes |
|---|---|---|
| `raid` | `tier-mn-1` | Raider.IO raid slug |
| `boss` | `midnight-falls` | Raider.IO boss slug |
| `difficulty` | `mythic` | |
| `region` | `eu` / `us` | |
| `realm` | `tarren-mill` | |
| `guild` | `echo` / `liquid` / `method` | must be a tracked guild |
| `period` | latest | optional, Raider.IO tracking period |
| `pullId` | most recent pull | optional, target a specific historical pull |
| `iterations` | `100` | hard-capped at `1000` |
| `threads` | `1` | keep low on memory-constrained hosts |
| `statistics_level` | `0` | higher = more detailed but heavier report |

`target_error` is not supported — it makes SimC run past the given `iterations` to converge, which would defeat the cap; `iterations` is the sole compute knob for both modes.

Response shape: `{ reportId, reportUrl, iterations, totalDps, playerCount, players[] }`, or `{ reportType: 'augmentation-multi', iterations, seed, baseline: { totalDps, reportUrl, players[] }, evokers[] }` if the roster has an Augmentation Evoker (`baseline` = all evokers asleep; each `evokers[]` entry has `contribution` — personal evoker dps isn't meaningful on its own). This always generates a real, fresh one-off HTML report (random id).

## Plain-text `.simc` export

`GET /api/get-simc` with no `sim`/`simc`/`format=html` flag returns the raw combined `.simc` profile text for a pull — live/synchronous per request, no sim run. Takes the same params as on-demand mode above (minus `iterations`/`threads`/`statistics_level`, which don't apply).

Errors return `{ "error": "..." }` with a 4xx/5xx status.

## Status

`GET /api/status` — JSON: `{ now, log: [...] }`, a rolling log (newest first, up to 200 entries) of worker and on-demand activity. Each entry: `{ timestamp, event, detail }`. Events: `manifest_refreshed`, `manifest_refresh_failed`, `pull_sim_started`, `pull_simmed`, `pull_sim_failed` (with a `cancelled` flag when it was preempted by an on-demand request rather than a real failure), `pull_sim_skipped` (a pull that failed and was given up on immediately, no retry), `on_demand_started`, `on_demand_complete`, `on_demand_failed`. The tail of the log doubles as "what's happening right now" — a `pull_sim_started` for a guild with no matching `pull_simmed`/`pull_sim_failed` yet means that pull is still being simmed. Not persisted to disk — resets on restart, same as any live activity feed.

`GET /status` — the same data as a plain auto-refreshing (5s) HTML page, for checking on it from a browser. Per-guild cards show backlog size, current iteration level, and the latest simmed pull's DPS.
