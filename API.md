# wow-armory-api

Single endpoint: `GET /api/get-simc`

Tracked guilds (`echo`, `liquid`, `method`) are continuously simmed in the background in small batches (every 5 min). `sim=true` with no other params reads that accumulator instantly instead of spawning a fresh sim — accuracy grows the longer a guild's roster/gear stays unchanged, and resets for a player (or, for the Augmentation Evoker numbers, the whole roster) the moment their SimC profile changes. `sim=true` with a full param set instead runs a one-off sim on demand for whatever pull you ask for (see below).

## `sim=true`, cached mode (no other params)

`GET /api/get-simc?sim=true` (or `simc=true`, `sim=1`, `simc=1`, `format=html`) — **no other query params.** Always returns every tracked guild at once:

```json
{
  "guilds": {
    "echo":   { "totalDps": 0, "playerCount": 0, "players": [], "reportId": "latest-echo", "reportUrl": "/api/get-simc?report=latest-echo" },
    "liquid": { ... },
    "method": { ... }
  }
}
```

Each guild's value is one of two shapes:

- **No Augmentation Evoker in roster**: `{ reportId, reportUrl, totalDps, playerCount, players[] }`.
- **Roster has one or more Augmentation Evokers**: `{ reportType: 'augmentation-multi', iterations, baseline: { totalDps, reportUrl, players[] }, evokers[] }`. `baseline` is the raid with all evokers asleep; each entry in `evokers[]` has `contribution` (that evoker's isolated raid-dps impact) — their personal dps isn't meaningful on its own, use `contribution`. `iterations` here is shared across `baseline` and every evoker, since they always reset/accumulate together.

Each entry in `players[]`: `name`, `realm`, `class`, `spec`, `ilevel` (average equipped item level), `dps` (accumulated average), `iterations` (how many iterations back that player's own number — players can reset independently on a gear/talent/enchant/gem change, so this may differ between players in the same guild).

A guild that hasn't completed its first background cycle yet just reads as empty (`players: []`, `totalDps: 0`) rather than erroring.

`report=<id>` (e.g. `report=latest-echo`) fetches the guild's latest HTML report directly — no other params needed, it's overwritten in place each cycle rather than accumulating a new file per batch.

## `sim=true`, on-demand mode (full param set)

`GET /api/get-simc?sim=true&raid=...&boss=...&difficulty=...&region=...&realm=...&guild=...` — pass the full param set and it runs a fresh sim right now for exactly the pull you describe, same as before this endpoint grew a background cache. Not limited to a guild's currently-tracked raid/boss — any raid/boss/difficulty/region/realm combination works, and `pullId`/`period` can target a specific historical pull.

This **preempts the background loop**: if a scheduled batch is mid-run when the request comes in, it's cancelled immediately so the on-demand sim doesn't wait behind it. The interrupted background cycle just quietly retries at its next 5-minute tick — no accumulated data is lost, since a cancelled batch is discarded the same way any other failed cycle is (last-known-good numbers keep serving from the cache in the meantime).

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
| `iterations` | `1500` | |
| `target_error` | `0.2` | |
| `threads` | `1` | keep low on memory-constrained hosts |
| `statistics_level` | `0` | higher = more detailed but heavier report |

Response shape: `{ reportId, reportUrl, iterations, totalDps, playerCount, players[] }`, or the `augmentation-multi` shape (`baseline` + `evokers[]`, as above) if the roster has an Augmentation Evoker. This is always a fresh one-off HTML report (random id), not the guild's rotating `latest-<guild>` report.

## Plain-text `.simc` export

`GET /api/get-simc` with no `sim`/`simc`/`format=html` flag returns the raw combined `.simc` profile text for a pull — live/synchronous per request, no sim run. Takes the same params as on-demand mode above (minus `iterations`/`target_error`/`threads`/`statistics_level`, which don't apply).

Errors return `{ "error": "..." }` with a 4xx/5xx status.
