const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const os = require('os');

const engine = require('./simcEngine');
const { TRACKED_GUILDS } = require('./guilds');
const statusLog = require('./statusLog');

const CACHE_DIR = process.env.CACHE_DIR || path.join(os.tmpdir(), 'wow-armory-api-cache');
const CACHE_FILE = path.join(CACHE_DIR, 'simc-cache.json');

// Bump this whenever a change means old persisted data shouldn't carry
// forward (new required fields, a changed sim methodology, etc.) — load()
// discards anything from a different version instead of trying to migrate
// it, so the worker starts clean and re-derives everything under the new
// logic. History:
//  - 2 -> 3: locked-in fight_style/max_time/etc. (old entries were simmed
//    with different implicit settings) and the switch from a hardcoded
//    MIN_PULL_DATE to auto-discovered cutoffs.
//  - 3 -> 4: added simcVersion per entry — old entries wouldn't have it, so
//    wipe rather than leave a permanent mixed-field-set inconsistency.
const CACHE_VERSION = 4;

const MANIFEST_REFRESH_MS = Number(process.env.SIMC_MANIFEST_REFRESH_MS) || 10 * 60 * 1000;
const IDLE_BACKOFF_MS = Number(process.env.SIMC_IDLE_BACKOFF_MS) || 45_000;
const MAX_HISTORY_PER_GUILD = Number(process.env.SIMC_MAX_HISTORY_PER_GUILD) || 2000;
// Old pulls can use a talent-tree layout that's incompatible with the
// current SimC build's talent data (a mid-tier talent rework breaks old
// exported hashes). Rather than hardcoding when that happened, the worker
// finds the boundary itself the first time it sees a raid+difficulty it
// hasn't checked yet — see discoverMinPullDate(). Cached in state.cutoffs,
// shared across all guilds on the same raid+difficulty so it's only ever
// paid for once. SIMC_MIN_PULL_DATE, if set, is a manual override that
// skips discovery entirely.
const MIN_PULL_DATE_OVERRIDE = process.env.SIMC_MIN_PULL_DATE || null;
const CUTOFF_DISCOVERY_SAMPLES = Number(process.env.SIMC_CUTOFF_DISCOVERY_SAMPLES) || 10;
const CUTOFF_DISCOVERY_MIN_HISTORY = Number(process.env.SIMC_CUTOFF_DISCOVERY_MIN_HISTORY) || 20;
const CUTOFF_PROBE_ITERATIONS = 1;

let state = { version: CACHE_VERSION, guilds: {}, cutoffs: {} };

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// backlog<=3 -> full 600 iterations; each pull beyond that halves it, floored
// at 15. Recomputed fresh before every pull, so iterations ramp up as the
// backlog drains and back down if new pulls arrive faster than we can work.
function computeIterations(backlog) {
    if (backlog <= 3) return 600;
    const raw = Math.round(600 / Math.pow(2, backlog - 3));
    return Math.min(600, Math.max(15, raw));
}

function emptyGuildState() {
    return {
        raid: null,
        difficulty: null,
        manifest: { bosses: [], pulls: [], lastRefreshed: null },
        simmedIds: {},
        history: [],
        lastSimmedAt: null,
        lastActivityAt: null
    };
}

function getOrInitGuildState(guildKey) {
    if (!state.guilds[guildKey]) {
        state.guilds[guildKey] = emptyGuildState();
    }
    return state.guilds[guildKey];
}

function computeBacklog(g) {
    let n = 0;
    for (const p of g.manifest.pulls) {
        if (!g.simmedIds[p.pullId]) n++;
    }
    return n;
}

function findNextPull(g) {
    return g.manifest.pulls.find(p => !g.simmedIds[p.pullId]) || null;
}

function load() {
    try {
        const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && parsed.guilds && parsed.version === CACHE_VERSION) {
            state = parsed;
            state.cutoffs = state.cutoffs || {};
        } else if (parsed && parsed.guilds) {
            console.warn(`simTracker: cache file is version ${parsed.version ?? '(none)'}, expected ${CACHE_VERSION} — starting fresh`);
            state = { version: CACHE_VERSION, guilds: {}, cutoffs: {} };
        }
    } catch (e) {
        // Missing or corrupt cache file — start empty, the worker repopulates it.
        state = { version: CACHE_VERSION, guilds: {}, cutoffs: {} };
    }
}

async function persist() {
    await fsPromises.mkdir(CACHE_DIR, { recursive: true });
    const tmpFile = `${CACHE_FILE}.tmp`;
    await fsPromises.writeFile(tmpFile, JSON.stringify(state), 'utf-8');
    await fsPromises.rename(tmpFile, CACHE_FILE);
}

// A cheap 1-iteration test sim, just to see whether this pull's talent data
// parses at all. Cancellation (preempted by an on-demand priority request)
// isn't a real signal either way, so it retries instead of counting as a
// failure — a discovery run shouldn't produce a wrong answer just because
// someone else needed the SimC queue for a moment.
async function probePull(cfg, guildKey, boss, pullId) {
    for (;;) {
        try {
            const simcData = await engine.getSimcPull(cfg.raid, boss, cfg.difficulty, cfg.region, cfg.realm, guildKey, cfg.guildId, pullId);
            const text = engine.buildCombinedSimcText(simcData.playerSimcMap, new Set());
            await engine.enqueueSimc(() => engine.runSimc(
                { combinedSimcText: text, playerMeta: simcData.playerMeta },
                { iterations: CUTOFF_PROBE_ITERATIONS, threads: 1, statisticsLevel: 0, skipHtml: true }
            ));
            return true;
        } catch (err) {
            if (/cancelled/i.test(err.message || '')) continue;
            return false;
        }
    }
}

// Finds the earliest point in a guild's full (unfiltered) pull history from
// which pulls reliably sim — the same method used manually to find this
// tier's boundary: sample evenly across the whole range, then binary-search
// between the last known-bad sample and the end of history to narrow it down.
// Returns: a date string (found a real boundary), null (every sample
// succeeded — no cutoff needed), or undefined (every sample failed —
// inconclusive, something else may be wrong; don't guess, try again later).
async function discoverMinPullDate(guildKey, cfg, sortedPulls) {
    const idxs = [...new Set(Array.from({ length: CUTOFF_DISCOVERY_SAMPLES }, (_, i) =>
        Math.floor(i * (sortedPulls.length - 1) / (CUTOFF_DISCOVERY_SAMPLES - 1))
    ))];

    let lastBadIdx = -1;
    for (const idx of idxs) {
        const p = sortedPulls[idx];
        const ok = await probePull(cfg, guildKey, p.boss, p.pullId);
        statusLog.log('cutoff_probe', { guild: guildKey, pullId: p.pullId, boss: p.boss, at: p.pullStartedAt, ok });
        if (!ok) lastBadIdx = idx;
    }

    if (lastBadIdx === -1) return null; // everything sampled succeeded
    if (lastBadIdx === sortedPulls.length - 1) return undefined; // everything sampled failed

    let lo = lastBadIdx, hi = sortedPulls.length - 1;
    while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        const p = sortedPulls[mid];
        const ok = await probePull(cfg, guildKey, p.boss, p.pullId);
        statusLog.log('cutoff_probe', { guild: guildKey, pullId: p.pullId, boss: p.boss, at: p.pullStartedAt, ok });
        if (ok) hi = mid; else lo = mid;
    }
    return sortedPulls[hi].pullStartedAt;
}

// Cached per raid+difficulty (not per guild — the underlying cause is a
// game-wide patch, so one guild's discovery run applies to all of them).
// Only actually caches a real outcome (a date, or a confirmed "no cutoff
// needed"); an inconclusive result isn't cached so it's retried once more
// history — or a fixed underlying issue — is available.
async function getMinPullDateForTier(guildKey, cfg, sortedPulls) {
    if (MIN_PULL_DATE_OVERRIDE) return MIN_PULL_DATE_OVERRIDE;

    const cutoffKey = `${cfg.raid}:${cfg.difficulty}`;
    if (cutoffKey in state.cutoffs) return state.cutoffs[cutoffKey];

    if (sortedPulls.length < CUTOFF_DISCOVERY_MIN_HISTORY) return null; // too little history yet to bother — not cached, retried later

    const discovered = await discoverMinPullDate(guildKey, cfg, sortedPulls);
    if (discovered !== undefined) {
        state.cutoffs[cutoffKey] = discovered;
        await persist();
    }
    statusLog.log('cutoff_discovered', {
        guild: guildKey, raid: cfg.raid, difficulty: cfg.difficulty,
        minPullDate: discovered === undefined ? 'inconclusive' : discovered, sampleCount: sortedPulls.length
    });
    return discovered ?? null;
}

// Rebuilds a guild's full pull manifest: every boss in the raid tier
// (including already-killed ones — farm/reclear pulls count), every pull on
// each, merged and sorted chronologically ascending ("earliest to latest").
async function refreshManifest(guildKey) {
    const cfg = TRACKED_GUILDS[guildKey];
    const g = getOrInitGuildState(guildKey);

    const rankings = await engine.getRaidRankings(cfg.raid, cfg.difficulty);
    const entry = rankings.find(r =>
        r.guild.name.toLowerCase() === guildKey.toLowerCase() &&
        r.guild.realm.slug.toLowerCase() === cfg.realm.toLowerCase()
    );
    const bosses = (entry?.encountersDefeated || []).map(e => e.slug);
    if (bosses.length === 0) throw new Error(`No boss list found for guild '${guildKey}' in raid rankings`);

    const rawPulls = [];
    for (const boss of bosses) {
        try {
            const pulls = await engine.getAllPulls(cfg.raid, boss, cfg.difficulty, cfg.region, cfg.realm, guildKey);
            for (const p of pulls) rawPulls.push({ boss, pullId: p.id, pullStartedAt: p.pullStartedAt });
        } catch (err) {
            // A boss the guild hasn't attempted yet (or a transient hiccup)
            // shouldn't take down the whole manifest refresh.
            console.warn(`simTracker: pull list fetch failed for '${guildKey}'/'${boss}':`, err.message);
        }
    }
    rawPulls.sort((a, b) => new Date(a.pullStartedAt) - new Date(b.pullStartedAt));

    const minPullDate = await getMinPullDateForTier(guildKey, cfg, rawPulls);
    const cutoff = minPullDate ? new Date(minPullDate) : null;
    const allPulls = cutoff ? rawPulls.filter(p => new Date(p.pullStartedAt) >= cutoff) : rawPulls;
    const filteredOld = rawPulls.length - allPulls.length;

    g.raid = cfg.raid;
    g.difficulty = cfg.difficulty;
    g.manifest = { bosses, pulls: allPulls, lastRefreshed: new Date().toISOString() };

    statusLog.log('manifest_refreshed', {
        guild: guildKey, bosses: bosses.length, pulls: allPulls.length, filteredOld, backlog: computeBacklog(g)
    });
    await persist();
}

async function ensureManifestFresh(guildKey) {
    const g = getOrInitGuildState(guildKey);
    const stale = !g.manifest.lastRefreshed ||
        (Date.now() - new Date(g.manifest.lastRefreshed).getTime() > MANIFEST_REFRESH_MS);
    const drained = g.manifest.pulls.length > 0 && computeBacklog(g) === 0;
    if (stale || drained) {
        try {
            await refreshManifest(guildKey);
        } catch (err) {
            console.warn(`simTracker: manifest refresh failed for '${guildKey}':`, err.message);
            statusLog.log('manifest_refresh_failed', { guild: guildKey, error: err.message });
        }
    }
}

// Sims one specific historical pull: baseline (all evokers asleep) plus one
// variant per Augmentation Evoker (that evoker awake), same contribution
// pattern as the on-demand path. Throws without recording anything on any
// failure (including cancellation) — the pull is simply retried whole next
// time it's picked up.
async function simOnePull(guildKey, pullEntry, iterations) {
    const cfg = TRACKED_GUILDS[guildKey];
    const simcData = await engine.getSimcPull(
        cfg.raid, pullEntry.boss, cfg.difficulty, cfg.region, cfg.realm, guildKey, cfg.guildId, pullEntry.pullId
    );

    const seed = Math.floor(Math.random() * 1_000_000_000);
    const evokerNamesLower = simcData.augmentationEvokers.map(n => n.toLowerCase());

    const baselineText = engine.buildCombinedSimcText(simcData.playerSimcMap, new Set(evokerNamesLower));
    const baseline = await engine.enqueueSimc(() => engine.runSimc(
        { combinedSimcText: baselineText, playerMeta: simcData.playerMeta },
        { iterations, threads: 1, statisticsLevel: 0, seed, skipHtml: true }
    ));

    const evokers = [];
    for (const evokerName of simcData.augmentationEvokers) {
        const lname = evokerName.toLowerCase();
        const sleeping = new Set(evokerNamesLower.filter(n => n !== lname));
        const variantText = engine.buildCombinedSimcText(simcData.playerSimcMap, sleeping);
        const variant = await engine.enqueueSimc(() => engine.runSimc(
            { combinedSimcText: variantText, playerMeta: simcData.playerMeta },
            { iterations, threads: 1, statisticsLevel: 0, seed, skipHtml: true }
        ));
        evokers.push({ name: evokerName, contribution: variant.totalDps - baseline.totalDps });
    }

    return {
        pullId: pullEntry.pullId,
        boss: pullEntry.boss,
        pullStartedAt: pullEntry.pullStartedAt,
        simmedAt: new Date().toISOString(),
        iterations,
        simcVersion: baseline.simcVersion,
        fightStyle: baseline.fightStyle,
        maxTime: baseline.maxTime,
        varyCombatLength: baseline.varyCombatLength,
        optimalRaid: baseline.optimalRaid,
        totalDps: baseline.totalDps,
        playerCount: baseline.players.length,
        players: baseline.players,
        evokers
    };
}

let workerStopped = true;
let workerLoopPromise = null;

async function runWorkerLoop() {
    while (!workerStopped) {
        let didWork = false;

        for (const guildKey of Object.keys(TRACKED_GUILDS)) {
            if (workerStopped) break;

            await ensureManifestFresh(guildKey);
            const g = state.guilds[guildKey];
            if (!g) continue;

            const nextPull = findNextPull(g);
            if (!nextPull) continue;

            const backlog = computeBacklog(g);
            const iterations = computeIterations(backlog);
            statusLog.log('pull_sim_started', { guild: guildKey, pullId: nextPull.pullId, boss: nextPull.boss, backlog, iterations });

            try {
                const result = await simOnePull(guildKey, nextPull, iterations);
                g.simmedIds[nextPull.pullId] = true;
                g.history.push(result);
                if (g.history.length > MAX_HISTORY_PER_GUILD) {
                    g.history.splice(0, g.history.length - MAX_HISTORY_PER_GUILD);
                }
                g.lastSimmedAt = result.simmedAt;
                g.lastActivityAt = result.simmedAt;
                await persist();
                statusLog.log('pull_simmed', { guild: guildKey, pullId: nextPull.pullId, boss: nextPull.boss, iterations, totalDps: result.totalDps });
                didWork = true;
            } catch (err) {
                const cancelled = /cancelled/i.test(err.message || '');
                statusLog.log('pull_sim_failed', { guild: guildKey, pullId: nextPull.pullId, error: err.message, cancelled });
                didWork = true;

                if (cancelled) continue; // preempted, not broken — just retry next pass, nothing recorded

                // No retry — one failure is enough to move on. Recorded as a
                // failed entry (not left for later) so a bad pull can't stall
                // the guild's backlog. lastSimmedAt (last REAL data) is
                // deliberately untouched here; lastActivityAt (last time the
                // worker touched this guild at all, success or skip) is what
                // moves — otherwise a guild grinding through a bad stretch of
                // skips looks falsely idle/stalled.
                const skippedAt = new Date().toISOString();
                g.simmedIds[nextPull.pullId] = true;
                g.history.push({
                    pullId: nextPull.pullId, boss: nextPull.boss, pullStartedAt: nextPull.pullStartedAt,
                    simmedAt: skippedAt, iterations: 0,
                    simcVersion: null, fightStyle: null, maxTime: null, varyCombatLength: null, optimalRaid: null,
                    totalDps: null, playerCount: 0,
                    players: [], evokers: [], failed: true, error: err.message
                });
                if (g.history.length > MAX_HISTORY_PER_GUILD) {
                    g.history.splice(0, g.history.length - MAX_HISTORY_PER_GUILD);
                }
                g.lastActivityAt = skippedAt;
                await persist();
                statusLog.log('pull_sim_skipped', { guild: guildKey, pullId: nextPull.pullId, error: err.message });
            }
        }

        if (!didWork && !workerStopped) await sleep(IDLE_BACKOFF_MS);
    }
}

function startWorker() {
    if (!workerStopped) return workerLoopPromise;
    workerStopped = false;
    workerLoopPromise = runWorkerLoop().catch(err => {
        console.error('simTracker: worker loop crashed', err);
    });
    return workerLoopPromise;
}

async function stopWorker() {
    if (workerStopped) return;
    workerStopped = true;
    engine.cancelCurrentSim(); // interrupt immediately instead of waiting out an in-flight sim
    if (workerLoopPromise) await workerLoopPromise.catch(() => {});
}

// `sincePull`/`sinceSim`, if given, must already be valid ISO datetime
// strings (validated by the caller). `sincePull` filters to pulls whose
// pullStartedAt (when the in-game attempt happened) is at or after it;
// `sinceSim` filters to pulls whose simmedAt (when our worker finished
// processing it — set on both successes and skipped failures) is at or
// after it. Both can be combined (both must hold). `limit` caps how many
// (newest-first) entries come back after those filters.
function getGuildView(guildKey, { limit, sincePull, sinceSim } = {}) {
    const g = state.guilds[guildKey];
    if (!g) {
        return {
            raid: null, difficulty: null, backlog: 0, currentIterations: null,
            lastSimmedAt: null, lastActivityAt: null, manifestLastRefreshed: null, history: []
        };
    }

    const backlog = computeBacklog(g);
    let historyDesc = g.history.slice().reverse(); // newest first

    if (sincePull) {
        const sinceMs = new Date(sincePull).getTime();
        historyDesc = historyDesc.filter(h => new Date(h.pullStartedAt).getTime() >= sinceMs);
    }
    if (sinceSim) {
        const sinceMs = new Date(sinceSim).getTime();
        historyDesc = historyDesc.filter(h => new Date(h.simmedAt).getTime() >= sinceMs);
    }

    const n = Number(limit);
    const limited = Number.isFinite(n) && n > 0 ? historyDesc.slice(0, n) : historyDesc;

    return {
        raid: g.raid,
        difficulty: g.difficulty,
        backlog,
        currentIterations: computeIterations(backlog),
        lastSimmedAt: g.lastSimmedAt,
        lastActivityAt: g.lastActivityAt,
        manifestLastRefreshed: g.manifest.lastRefreshed,
        history: limited
    };
}

function getAllGuildsView(options) {
    const result = {};
    for (const guildKey of Object.keys(TRACKED_GUILDS)) {
        result[guildKey] = getGuildView(guildKey, options);
    }
    return result;
}

module.exports = {
    load,
    persist,
    startWorker,
    stopWorker,
    getGuildView,
    getAllGuildsView,
    computeIterations
};
