const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const engine = require('./simcEngine');
const { TRACKED_GUILDS } = require('./guilds');
const statusLog = require('./statusLog');

const BATCH_ITERATIONS = Number(process.env.SIMC_BATCH_ITERATIONS) || 100;

const CACHE_DIR = process.env.CACHE_DIR || path.join(os.tmpdir(), 'wow-armory-api-cache');
const CACHE_FILE = path.join(CACHE_DIR, 'simc-cache.json');

let state = { version: 1, guilds: {} };

function hashText(text) {
    return crypto.createHash('sha1').update(text || '').digest('hex');
}

function emptyGuildState() {
    return {
        pullId: null,
        rosterHash: null,
        lastUpdated: null,
        latestReportUrl: null,
        players: {},
        evokers: {
            baseline: { samples: 0, sumDps: 0 },
            byName: {}
        }
    };
}

function load() {
    try {
        const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && parsed.guilds) {
            state = parsed;
        }
    } catch (e) {
        // Missing or corrupt cache file — start empty, the next cycle repopulates it.
        state = { version: 1, guilds: {} };
    }
}

async function persist() {
    await fsPromises.mkdir(CACHE_DIR, { recursive: true });
    const tmpFile = `${CACHE_FILE}.tmp`;
    await fsPromises.writeFile(tmpFile, JSON.stringify(state), 'utf-8');
    await fsPromises.rename(tmpFile, CACHE_FILE);
}

function averageOf(samples, sum) {
    return samples > 0 ? Math.round(sum / samples) : 0;
}

function buildPlayersList(guildState) {
    return Object.values(guildState.players).map(p => ({
        name: p.name,
        realm: p.realm,
        class: p.class,
        spec: p.spec,
        ilevel: p.ilevel,
        dps: averageOf(p.samples, p.sumDps),
        iterations: p.samples
    }));
}

async function runGuildCycle(guildKey) {
    const cfg = TRACKED_GUILDS[guildKey];
    if (!cfg) return;

    const previous = state.guilds[guildKey] || emptyGuildState();
    let next = structuredClone(previous);

    statusLog.log('cycle_started', { guild: guildKey });

    try {
        const pullId = await engine.getRecentPullId(cfg.raid, cfg.boss, cfg.difficulty, cfg.region, cfg.realm, guildKey);
        const simcData = await engine.getSimcPull(cfg.raid, cfg.boss, cfg.difficulty, cfg.region, cfg.realm, guildKey, cfg.guildId, pullId);

        const rosterHash = hashText(simcData.combinedSimcText);
        const rosterChanged = next.rosterHash !== rosterHash;
        if (rosterChanged) {
            next.evokers = { baseline: { samples: 0, sumDps: 0 }, byName: {} };
        }
        statusLog.log('roster_fetched', {
            guild: guildKey,
            pullId,
            players: Object.keys(simcData.playerSimcMap).length,
            evokers: simcData.augmentationEvokers.length,
            rosterChanged
        });

        const seed = Math.floor(Math.random() * 1_000_000_000);
        const evokerNamesLower = simcData.augmentationEvokers.map(n => n.toLowerCase());
        const reportId = `latest-${guildKey}`;

        const baselineText = engine.buildCombinedSimcText(simcData.playerSimcMap, new Set(evokerNamesLower));
        const baseline = await engine.enqueueSimc(() => engine.runSimc(
            { combinedSimcText: baselineText, playerMeta: simcData.playerMeta },
            { iterations: BATCH_ITERATIONS, threads: 1, statisticsLevel: 0, seed, reportId }
        ));

        next.evokers.baseline.samples += BATCH_ITERATIONS;
        next.evokers.baseline.sumDps += baseline.totalDps * BATCH_ITERATIONS;
        statusLog.log('baseline_batch_complete', { guild: guildKey, totalDps: baseline.totalDps, iterations: BATCH_ITERATIONS });

        const currentPlayerNames = new Set();
        for (const p of baseline.players) {
            const lname = p.name.toLowerCase();
            if (evokerNamesLower.includes(lname)) continue; // evokers never get a personal accumulator

            currentPlayerNames.add(lname);
            const blockHash = hashText(simcData.playerSimcMap[lname]);
            let entry = next.players[lname];
            if (!entry || entry.blockHash !== blockHash) {
                entry = { samples: 0, sumDps: 0 };
            }
            entry.samples += BATCH_ITERATIONS;
            entry.sumDps += p.dps * BATCH_ITERATIONS;
            entry.name = p.name;
            entry.realm = p.realm;
            entry.class = p.class;
            entry.spec = p.spec;
            entry.ilevel = p.ilevel;
            entry.blockHash = blockHash;
            next.players[lname] = entry;
        }
        for (const lname of Object.keys(next.players)) {
            if (!currentPlayerNames.has(lname)) delete next.players[lname];
        }

        const currentEvokerNames = new Set();
        for (const evokerName of simcData.augmentationEvokers) {
            const lname = evokerName.toLowerCase();
            currentEvokerNames.add(lname);

            const sleeping = new Set(evokerNamesLower.filter(n => n !== lname));
            const variantText = engine.buildCombinedSimcText(simcData.playerSimcMap, sleeping);
            const variant = await engine.enqueueSimc(() => engine.runSimc(
                { combinedSimcText: variantText, playerMeta: simcData.playerMeta },
                { iterations: BATCH_ITERATIONS, threads: 1, statisticsLevel: 0, seed, reportId }
            ));

            const contribution = variant.totalDps - baseline.totalDps;
            const entry = next.evokers.byName[lname] || { samples: 0, sumContribution: 0 };
            entry.samples += BATCH_ITERATIONS;
            entry.sumContribution += contribution * BATCH_ITERATIONS;
            entry.name = evokerName;
            next.evokers.byName[lname] = entry;
            statusLog.log('evoker_batch_complete', { guild: guildKey, evoker: evokerName, contribution, iterations: BATCH_ITERATIONS });
        }
        for (const lname of Object.keys(next.evokers.byName)) {
            if (!currentEvokerNames.has(lname)) delete next.evokers.byName[lname];
        }

        next.pullId = pullId;
        next.rosterHash = rosterHash;
        next.lastUpdated = new Date().toISOString();
        next.latestReportUrl = `/api/get-simc?report=${reportId}`;
        statusLog.log('cycle_complete', { guild: guildKey, pullId });
    } catch (err) {
        console.error(`simTracker: cycle failed for guild '${guildKey}':`, err.message);
        statusLog.log('cycle_failed', { guild: guildKey, error: err.message });
        next = previous; // discard any partial mutations, keep serving last-known-good data
    }

    state.guilds[guildKey] = next;
    await persist();
}

async function runAllGuildCycles() {
    for (const guildKey of Object.keys(TRACKED_GUILDS)) {
        await runGuildCycle(guildKey);
    }
}

function getGuildView(guildKey) {
    const g = state.guilds[guildKey] || emptyGuildState();
    const reportId = `latest-${guildKey}`;
    const reportUrl = g.latestReportUrl || `/api/get-simc?report=${reportId}`;
    const players = buildPlayersList(g);

    const evokerEntries = Object.values(g.evokers.byName);
    if (evokerEntries.length === 0) {
        return {
            reportId,
            reportUrl,
            totalDps: players.reduce((sum, p) => sum + p.dps, 0),
            playerCount: players.length,
            players
        };
    }

    const baselineDps = averageOf(g.evokers.baseline.samples, g.evokers.baseline.sumDps);
    return {
        reportType: 'augmentation-multi',
        iterations: g.evokers.baseline.samples,
        baseline: {
            totalDps: baselineDps,
            reportUrl,
            players
        },
        evokers: evokerEntries.map(e => {
            const contribution = averageOf(e.samples, e.sumContribution);
            return {
                name: e.name,
                totalDpsWithThisEvokerAwake: baselineDps + contribution,
                contribution,
                reportUrl
            };
        })
    };
}

function getAllGuildsView() {
    const result = {};
    for (const guildKey of Object.keys(TRACKED_GUILDS)) {
        result[guildKey] = getGuildView(guildKey);
    }
    return result;
}

module.exports = {
    load,
    persist,
    runGuildCycle,
    runAllGuildCycles,
    getGuildView,
    getAllGuildsView,
    hashText,
    BATCH_ITERATIONS
};
