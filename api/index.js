const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');

const engine = require('../lib/simcEngine');
const { getGuild } = require('../lib/guilds');
const tracker = require('../lib/simTracker');
const statusLog = require('../lib/statusLog');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        const clean = (val) => (val === 'undefined' || val === 'null' || val === '') ? undefined : val;

        // -------------------------------------------------------------
        // Serve HTML Report if `?report=<ID>` parameter exists
        // -------------------------------------------------------------
        let reportId = clean(req.query.report);
        if (reportId) {
            // Prevent directory traversal attacks
            const safeReportId = path.basename(reportId).replace(/[^a-zA-Z0-9-]/g, '');
            const htmlPath = path.join(engine.reportsDir, `${safeReportId}.html`);

            if (fs.existsSync(htmlPath)) {
                const htmlContent = await fsPromises.readFile(htmlPath, 'utf-8');
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                return res.status(200).send(htmlContent);
            } else {
                return res.status(404).json({ error: 'Report not found or expired.' });
            }
        }

        // -------------------------------------------------------------
        // sim=true with no other params: instant read of the pull-backlog
        // worker's accumulated history, covering every tracked guild at once.
        //
        // sim=true WITH a full raid/boss/difficulty/region/realm/guild set:
        // the on-demand mode — sim whatever pull that describes (any boss,
        // any historical pullId), right now. This preempts whatever pull the
        // background worker is currently mid-sim on (via enqueueSimcPriority,
        // which cancels it) so the on-demand request doesn't wait behind it;
        // the worker just retries that same pull on its next pass.
        // -------------------------------------------------------------
        const runSim = req.query.sim === 'true' ||
             req.query.simc === 'true' ||
             req.query.sim === '1' ||
             req.query.simc === '1' ||
             req.query.format === 'html';

        if (runSim) {
            const raid = clean(req.query.raid);
            const boss = clean(req.query.boss);
            const difficulty = clean(req.query.difficulty);
            const region = clean(req.query.region);
            const realm = clean(req.query.realm);
            const guild = clean(req.query.guild);
            const period = clean(req.query.period);
            let pullId = clean(req.query.pullId);

            const hasFullParams = raid && boss && difficulty && region && realm && guild;
            if (!hasFullParams) {
                const limit = clean(req.query.limit);
                return res.status(200).json({ guilds: tracker.getAllGuildsView(limit) });
            }

            const tracked = getGuild(guild);
            if (!tracked) {
                return res.status(400).json({
                    error: `Guild '${guild}' is not a tracked guild.`
                });
            }

            if (!pullId) {
                pullId = await engine.getRecentPullId(raid, boss, difficulty, region, realm, guild, period);
            }

            statusLog.log('on_demand_started', { guild, raid, boss, difficulty, region, realm, pullId });

            try {
                const simcData = await engine.getSimcPull(raid, boss, difficulty, region, realm, guild, tracked.guildId, pullId);

                // Default 100, hard-capped at 1000. target_error is
                // intentionally never passed here — it makes SimC keep
                // running past `iterations` to converge, which would silently
                // defeat the cap. iterations is the sole, exact compute knob.
                const rawIterations = Number(req.query.iterations) || 100;
                const iterations = Math.min(1000, Math.max(1, rawIterations));
                const simOptions = {
                    iterations,
                    threads: Number(req.query.threads) || 1,
                    statisticsLevel: req.query.statistics_level !== undefined ? Number(req.query.statistics_level) : 0,
                    // Shared across every sub-sim of this request so unrelated raid
                    // members roll identically each time - only the evoker(s)
                    // being awake/asleep should move the totals.
                    seed: Math.floor(Math.random() * 1_000_000_000)
                };

                if (simcData.augmentationEvokers.length > 0) {
                    const evokerNames = simcData.augmentationEvokers.map(n => n.toLowerCase());
                    const allSleeping = new Set(evokerNames);

                    const baselineText = engine.buildCombinedSimcText(simcData.playerSimcMap, allSleeping);
                    const baseline = await engine.enqueueSimcPriority(() => engine.runSimc(
                        { combinedSimcText: baselineText, playerMeta: simcData.playerMeta }, simOptions
                    ));

                    const evokers = [];
                    for (const evokerName of simcData.augmentationEvokers) {
                        const lowerName = evokerName.toLowerCase();
                        const sleeping = new Set(evokerNames.filter(n => n !== lowerName));
                        const variantText = engine.buildCombinedSimcText(simcData.playerSimcMap, sleeping);
                        const variant = await engine.enqueueSimcPriority(() => engine.runSimc(
                            { combinedSimcText: variantText, playerMeta: simcData.playerMeta }, simOptions
                        ));

                        evokers.push({
                            name: evokerName,
                            totalDpsWithThisEvokerAwake: variant.totalDps,
                            contribution: variant.totalDps - baseline.totalDps,
                            reportUrl: variant.reportUrl,
                            players: variant.players
                        });
                    }

                    statusLog.log('on_demand_complete', { guild, raid, boss, pullId });
                    return res.status(200).json({
                        reportType: 'augmentation-multi',
                        iterations: simOptions.iterations,
                        seed: simOptions.seed,
                        baseline: {
                            totalDps: baseline.totalDps,
                            reportUrl: baseline.reportUrl,
                            players: baseline.players
                        },
                        evokers
                    });
                }

                const simResults = await engine.enqueueSimcPriority(() => engine.runSimc(simcData, simOptions));
                statusLog.log('on_demand_complete', { guild, raid, boss, pullId });
                return res.status(200).json(simResults);
            } catch (err) {
                statusLog.log('on_demand_failed', { guild, raid, boss, pullId, error: err.message });
                throw err;
            }
        }

        // -------------------------------------------------------------
        // Plain-text .simc export — unchanged, still live per request
        // -------------------------------------------------------------
        let raid = clean(req.query.raid);
        let boss = clean(req.query.boss);
        let difficulty = clean(req.query.difficulty);
        let region = clean(req.query.region);
        let realm = clean(req.query.realm);
        let guild = clean(req.query.guild);
        let period = clean(req.query.period);
        let pullId = clean(req.query.pullId);

        const missingParams = [];
        if (!raid) missingParams.push("raid");
        if (!boss) missingParams.push("boss");
        if (!difficulty) missingParams.push("difficulty");
        if (!region) missingParams.push("region");
        if (!realm) missingParams.push("realm");
        if (!guild) missingParams.push("guild");

        if (missingParams.length > 0) {
            return res.status(400).json({
                error: `Missing required query parameters: ${missingParams.join(", ")}`
            });
        }

        const tracked = getGuild(guild);
        if (!tracked) {
            return res.status(400).json({
                error: `Guild '${guild}' is not a tracked guild.`
            });
        }

        if (!pullId) {
            pullId = await engine.getRecentPullId(raid, boss, difficulty, region, realm, guild, period);
        }

        const simcData = await engine.getSimcPull(raid, boss, difficulty, region, realm, guild, tracked.guildId, pullId);

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.status(200).send(simcData.combinedSimcText);

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};
