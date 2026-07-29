# wow-armory-api

Single endpoint: `GET /api/get-simc`

Pulls a guild's most recent raid pull from Raider.IO, builds a SimC profile for every non-healer in the roster, and (optionally) runs SimulationCraft on it.

## Required query params

| Param | Example | Notes |
|---|---|---|
| `raid` | `tier-mn-1` | Raider.IO raid slug |
| `boss` | `midnight-falls` | Raider.IO boss slug |
| `difficulty` | `mythic` | |
| `region` | `eu` / `us` | |
| `realm` | `tarren-mill` | |
| `guild` | `echo` / `liquid` / `method` | must be a key in `guild_ids` |

## Optional query params

| Param | Default | Notes |
|---|---|---|
| `period` | latest | Raider.IO tracking period |
| `pullId` | most recent pull | skip auto-lookup, target a specific pull |
| `sim=true` (or `simc=true`, `format=html`) | off | actually run SimC instead of just returning the `.simc` text |
| `iterations` | `1500` | |
| `target_error` | `0.2` | |
| `threads` | `1` | keep low on memory-constrained hosts |
| `statistics_level` | `0` | higher = more detailed but heavier report |
| `report=<id>` | — | fetch a previously generated HTML report instead of running anything |

## Responses

- No `sim` flag: plain-text `.simc` profile for the whole roster.
- `sim=true`, no Augmentation Evoker in roster: JSON with `totalDps`, `players[]`, and a `reportUrl` to the HTML report.
- `sim=true`, roster has one or more Augmentation Evokers: JSON with a `baseline` sim (all aug evokers asleep) and an `evokers[]` array — one entry per evoker with `contribution` (their isolated raid-dps impact) and their own `reportUrl`. Personal evoker dps is not meaningful on its own; use `contribution`.
- `report=<id>`: raw HTML report page.

Each entry in `players[]` has: `name`, `realm`, `class`, `spec`, `ilevel` (average equipped item level), `dps`.

Errors return `{ "error": "..." }` with a 4xx/5xx status.
