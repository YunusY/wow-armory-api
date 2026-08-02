const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const os = require('os');

const engine = require('./simcEngine');
const { TRACKED_GUILDS } = require('./guilds');
const statusLog = require('./statusLog');

const CACHE_DIR = process.env.CACHE_DIR || path.join(os.tmpdir(), 'wow-armory-api-cache');
const CACHE_FILE = path.join(CACHE_DIR, 'simc-cache.json');

const MANIFEST_REFRESH_MS = Number(process.env.SIMC_MANIFEST_REFRESH_MS) || 10 * 60 * 1000;
const IDLE_BACKOFF_MS = Number(process.env.SIMC_IDLE_BACKOFF_MS) || 45_000;
const MAX_HISTORY_PER_GUILD = Number(process.env.SIMC_MAX_HISTORY_PER_GUILD) || 2000;

let state = { version: 2, guilds: {} };

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
        if (parsed && parsed.guilds) {
            state = parsed;
        }
    } catch (e) {
        // Missing or corrupt cache file — start empty, the worker repopulates it.
        state = { version: 2, guilds: {} };
    }
}

async function persist() {
    await fsPromises.mkdir(CACHE_DIR, { recursive: true });
    const tmpFile = `${CACHE_FILE}.tmp`;
    await fsPromises.writeFile(tmpFile, JSON.stringify(state), 'utf-8');
    await fsPromises.rename(tmpFile, CACHE_FILE);
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

    const allPulls = [];
    for (const boss of bosses) {
        try {
            const pulls = await engine.getAllPulls(cfg.raid, boss, cfg.difficulty, cfg.region, cfg.realm, guildKey);
            for (const p of pulls) allPulls.push({ boss, pullId: p.id, pullStartedAt: p.pullStartedAt });
        } catch (err) {
            // A boss the guild hasn't attempted yet (or a transient hiccup)
            // shouldn't take down the whole manifest refresh.
            console.warn(`simTracker: pull list fetch failed for '${guildKey}'/'${boss}':`, err.message);
        }
    }
    allPulls.sort((a, b) => new Date(a.pullStartedAt) - new Date(b.pullStartedAt));

    g.raid = cfg.raid;
    g.difficulty = cfg.difficulty;
    g.manifest = { bosses, pulls: allPulls, lastRefreshed: new Date().toISOString() };

    statusLog.log('manifest_refreshed', {
        guild: guildKey, bosses: bosses.length, pulls: allPulls.length, backlog: computeBacklog(g)
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
                    simmedAt: skippedAt, iterations: 0, totalDps: null, playerCount: 0,
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

function getGuildView(guildKey, limit) {
    const g = state.guilds[guildKey];
    if (!g) {
        return {
            raid: null, difficulty: null, backlog: 0, currentIterations: null,
            lastSimmedAt: null, lastActivityAt: null, manifestLastRefreshed: null, history: []
        };
    }

    const backlog = computeBacklog(g);
    const historyDesc = g.history.slice().reverse(); // newest first
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

function getAllGuildsView(limit) {
    const result = {};
    for (const guildKey of Object.keys(TRACKED_GUILDS)) {
        result[guildKey] = getGuildView(guildKey, limit);
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
