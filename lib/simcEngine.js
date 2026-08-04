const https = require('https');
const dns = require('dns');
const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');

if (dns && dns.setDefaultResultOrder) {
    try { dns.setDefaultResultOrder('ipv4first'); } catch (e) {}
}

const clientId = (process.env.BLIZZARD_CLIENT_ID || '').trim();
const clientSecret = (process.env.BLIZZARD_CLIENT_SECRET || '').trim();

// Hardcoded BoE list. Previous tier's items are kept since some may still
// see early use into the next tier.
const boeItems = [
    "primal_spark_pauldrons",
    "power_stance_breeches",
    "visage_of_unseen_truths",
    "infernal_greatlock_girdle",
    "nullstriders_boots",
    "raging_storm_sash",
    "fading_dawn_sabatons",
    "breastplate_of_the_final_defense",
    // next tier
    "bound_serpents_jade_eye",
    "temple_delvers_mystic_helm",
    "crushing_coiler_coif",
    "venom_rite_mantle",
    "pauldrons_of_the_forgotten_sacrifice",
    "slitherscale_girdle",
    "fanged_brutes_greatbelt",
    "slippers_of_the_hissing_cult",
    "greaves_of_the_noxious_depths"
];

const healerSpecs = ["restoration", "holy", "preservation", "mistweaver", "discipline"];

const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json"
};

const reportsDir = process.env.REPORTS_DIR || path.join(os.tmpdir(), 'wow-armory-api-reports');
if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
}

let blizzardToken = null;
let tokenExpiry = 0;

function getSimcBinaryPath() {
    const simcPath = (process.env.SIMC_PATH || '').trim();
    if (simcPath) {
        if (fs.existsSync(simcPath)) return simcPath;
        console.warn(`SIMC_PATH is set to '${simcPath}' but the file was not found.`);
    }

    const isWindows = process.platform === 'win32';
    const possiblePaths = [
        path.resolve(__dirname, '../simc/simc'),
        path.resolve(process.cwd(), 'simc/simc'),
        '/usr/local/bin/simc'
    ];

    if (isWindows) {
        possiblePaths.push(
            path.resolve(__dirname, '../simc/simc.exe'),
            path.resolve(process.cwd(), 'simc/simc.exe')
        );
    }

    for (const p of possiblePaths) {
        if (fs.existsSync(p)) return p;
    }

    return isWindows ? 'simc.exe' : 'simc';
}

function getBlizzardToken(region = 'eu') {
    return new Promise((resolve) => {
        if (blizzardToken && Date.now() < tokenExpiry) {
            return resolve(blizzardToken);
        }
        if (!clientId || !clientSecret) return resolve(null);

        const cleanRegion = (region || 'eu').toLowerCase();
        const tokenHost = ['eu', 'us', 'kr', 'tw'].includes(cleanRegion) ? `${cleanRegion}.battle.net` : 'oauth.battle.net';
        const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        const postData = 'grant_type=client_credentials';

        const req = https.request({
            hostname: tokenHost,
            path: '/oauth/token',
            method: 'POST',
            family: 4,
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData),
                'User-Agent': headers['User-Agent']
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const parsed = JSON.parse(data);
                        blizzardToken = parsed.access_token;
                        tokenExpiry = Date.now() + (parsed.expires_in - 60) * 1000;
                        resolve(blizzardToken);
                    } catch (e) { resolve(null); }
                } else { resolve(null); }
            });
        });

        req.on('error', () => resolve(null));
        req.write(postData);
        req.end();
    });
}

function fetchArmoryEquipment(token, region, realm, character) {
    return new Promise((resolve) => {
        if (!token) return resolve(null);

        const cleanRegion = (region || 'eu').toLowerCase();
        const realmSlug = encodeURIComponent(realm.toLowerCase().replace(/'/g, '').replace(/\s+/g, '-'));
        const nameSlug = encodeURIComponent(character.toLowerCase());

        const req = https.request({
            hostname: `${cleanRegion}.api.blizzard.com`,
            path: `/profile/wow/character/${realmSlug}/${nameSlug}/equipment?namespace=profile-${cleanRegion}&locale=en_US`,
            method: 'GET',
            family: 4,
            headers: {
                'Authorization': `Bearer ${token}`,
                'User-Agent': headers['User-Agent']
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const parsed = JSON.parse(data);
                        resolve(parsed.equipped_items || null);
                    } catch (e) { resolve(null); }
                } else { resolve(null); }
            });
        });

        req.on('error', () => resolve(null));
        req.end();
    });
}

function extractCraftedStats(armoryItem) {
    if (!armoryItem || !armoryItem.stats) return null;

    const parsedStats = [];
    for (const s of armoryItem.stats) {
        const typeStr = `${s.type?.type || ''} ${s.type?.name || ''}`.toUpperCase();
        let statId = null;

        if (typeStr.includes("CRIT")) statId = "32";
        else if (typeStr.includes("HASTE")) statId = "36";
        else if (typeStr.includes("VERSATIL") || typeStr.includes("VERSA")) statId = "40";
        else if (typeStr.includes("MASTERY")) statId = "49";

        if (statId) {
            parsedStats.push({ id: statId, value: s.value || 0 });
        }
    }

    parsedStats.sort((a, b) => b.value - a.value);

    if (parsedStats.length > 0) {
        return parsedStats.map(s => s.id).join("/");
    }
    return null;
}

async function getRecentPullId(raid, boss, difficulty, region, realm, guild, period) {
    const params = new URLSearchParams({ raid, boss, difficulty, region, realm, guild });
    if (period) params.append('period', period);

    const url = `https://raider.io/api/v1/live-tracking/guild/boss-pulls?${params.toString()}`;
    const response = await fetch(url, { headers });

    if (!response.ok) throw new Error(`Raider.IO Boss-Pulls Error: HTTP ${response.status}`);

    const data = await response.json();
    if (!data.pulls || data.pulls.length === 0) throw new Error('No pulls found on Raider.IO for these parameters.');

    return data.pulls[data.pulls.length - 1].details.id;
}

// World-wide (region='world') per-boss kill order/timestamps for every guild
// ranked on a given raid+difficulty. Used to enumerate the full boss list for
// a tier (via `encountersDefeated[].slug`) since raider.io doesn't otherwise
// expose a raid's boss roster directly.
async function getRaidRankings(raid, difficulty) {
    const params = new URLSearchParams({ raid, difficulty, region: 'world' });
    const url = `https://raider.io/api/v1/raiding/raid-rankings?${params.toString()}`;
    const response = await fetch(url, { headers });

    if (!response.ok) throw new Error(`Raider.IO Raid-Rankings Error: HTTP ${response.status}`);

    const data = await response.json();
    return data.raidRankings || [];
}

// Every pull a guild has ever made on a given boss, chronologically ascending
// (confirmed live — raider.io's live-tracking history is not windowed).
// Returns [] rather than throwing on no pulls: under full-tier backlog
// enumeration, a boss the guild simply hasn't attempted yet is expected, not
// exceptional. IDs are coerced to strings here, once, at the source, so every
// downstream consumer (manifest, already-simmed set, history) uses a
// consistent key type.
async function getAllPulls(raid, boss, difficulty, region, realm, guild, period) {
    const params = new URLSearchParams({ raid, boss, difficulty, region, realm, guild });
    if (period) params.append('period', period);

    const url = `https://raider.io/api/v1/live-tracking/guild/boss-pulls?${params.toString()}`;
    const response = await fetch(url, { headers });

    if (!response.ok) throw new Error(`Raider.IO Boss-Pulls Error: HTTP ${response.status}`);

    const data = await response.json();
    if (!data.pulls || data.pulls.length === 0) return [];

    return data.pulls.map(p => ({
        id: String(p.details.id),
        pullStartedAt: p.details.pull_started_at
    }));
}

async function getSimcPull(raid, boss, difficulty, region, realm, guild, guild_id, pullId) {
    const params = new URLSearchParams({ raid, difficulty, id: pullId, guild_id, region, realm, boss, guild });
    const url = `https://raider.io/api/v1/live-tracking/guild/raid-comps?${params.toString()}`;
    const response = await fetch(url, { headers });

    if (!response.ok) throw new Error(`Raider.IO Raid-Comps Error: HTTP ${response.status}`);

    const data = await response.json();
    if (!data.details || !data.details.roster) throw new Error('Roster data is missing.');

    const slots = ["head", "neck", "shoulder", "back", "chest", "waist", "wrist", "hands", "legs", "feet", "finger1", "finger2", "trinket1", "trinket2", "mainhand", "offhand"];

    const playersToFetch = [];
    for (let i = 0; i < 20; i++) {
        if (!data.details.roster[i]) break;
        const p = data.details.roster[i].character;
        let hasBoe = false;

        const items = p.items.items;
        for (const slot of slots) {
            if (items[slot]) {
                const rawName = items[slot].name.toLowerCase().replace(/'/g, '');
                if (boeItems.some(boe => rawName.includes(boe.replace(/_/g, ' ')))) {
                    hasBoe = true;
                    break;
                }
            }
        }

        if (hasBoe) {
            const playerRealm = (p.realm && p.realm.slug) ? p.realm.slug : realm;
            playersToFetch.push({ index: i, name: p.name, realm: playerRealm });
        }
    }

    const armoryData = {};
    if (playersToFetch.length > 0) {
        const cleanRegion = (region || "eu").toLowerCase();
        const token = await getBlizzardToken(cleanRegion);

        if (token) {
            await Promise.all(playersToFetch.map(async (player) => {
                const equipment = await fetchArmoryEquipment(token, cleanRegion, player.realm, player.name);
                if (equipment) {
                    armoryData[player.index] = equipment;
                }
            }));
        }
    }

    let combinedSimcText = "";
    const playerSimcMap = {};
    const playerMeta = {};
    const augmentationEvokers = [];

    for (let i = 0; i < 20; i++) {
        if (!data.details.roster[i]) break;
        const p = data.details.roster[i].character;

        const cleanClass = p.class.slug.toLowerCase().replace(/[^a-z0-9]/g, "");
        const cleanRace = p.race.slug.toLowerCase().replace(/[\s-]+/g, "_");
        const cleanSpec = p.spec.name.toLowerCase().trim().replace(/[\s-]+/g, "_");

        const isHealer = (p.spec.role && p.spec.role.toLowerCase() === 'healer') || healerSpecs.includes(cleanSpec);
        if (isHealer) continue;

        if (cleanClass === 'evoker' && cleanSpec === 'augmentation') {
            augmentationEvokers.push(p.name);
        }

        let playerSimc = `${cleanClass}=${p.name}\nlevel=90\nrace=${cleanRace}\nspec=${cleanSpec}\n`;
        if (p.talentLoadout && p.talentLoadout.exportLoadoutText) {
            playerSimc += `talents=${p.talentLoadout.exportLoadoutText}\n`;
        }

        const items = p.items.items;

        for (const slot of slots) {
            const item = items[slot];
            if (item) {
                const itemName = item.name.replace(/'/g, "").replace(/[^a-zA-Z0-9_]/g, "_");
                const isBoe = boeItems.some(boe => itemName.toLowerCase().includes(boe));

                const simcSlot = (slot === "mainhand") ? "main_hand" : (slot === "offhand") ? "off_hand" : slot;
                let itemLine = `${simcSlot}=${itemName},id=${item.item_id}`;

                if (item.enchant) {
                    const cleanEnchant = String(item.enchant).trim();
                    if (/^\d+$/.test(cleanEnchant)) itemLine += `,enchant_id=${cleanEnchant}`;
                }

                if (item.gems && Array.isArray(item.gems) && item.gems.length > 0) {
                    const validGems = item.gems.map(g => String(g).trim()).filter(g => /^\d+$/.test(g));
                    if (validGems.length > 0) itemLine += `,gem_id=${validGems.join('/')}`;
                }

                if (item.bonuses && Array.isArray(item.bonuses) && item.bonuses.length > 0) {
                    const validBonuses = item.bonuses.map(b => String(b).trim()).filter(b => /^\d+$/.test(b));
                    if (validBonuses.length > 0) itemLine += `,bonus_id=${validBonuses.join('/')}`;
                }

                if (isBoe && armoryData[i]) {
                    const baseSlot = slot.replace(/\d+$/, "").toUpperCase();
                    const armoryItem = armoryData[i].find(ai =>
                        String(ai.item?.id) === String(item.item_id) ||
                        ai.slot?.type === baseSlot
                    );

                    const craftedStats = extractCraftedStats(armoryItem);
                    if (craftedStats) itemLine += `,crafted_stats=${craftedStats}`;
                }

                playerSimc += itemLine + "\n";
            }
        }

        playerSimcMap[p.name.toLowerCase()] = playerSimc.trim();
        playerMeta[p.name.toLowerCase()] = {
            realm: (p.realm && p.realm.slug) ? p.realm.slug : realm,
            class: cleanClass,
            spec: cleanSpec
        };
        combinedSimcText += playerSimc + "\n\n";
    }

    return {
        combinedSimcText: combinedSimcText.trim(),
        playerSimcMap,
        playerMeta,
        augmentationEvokers
    };
}

// Rebuilds the combined SimC text from the per-player blocks, marking the
// given (lowercase) player names as sleeping so they contribute no damage
// or buffs to the sim.
function buildCombinedSimcText(playerSimcMap, sleepingNames = new Set()) {
    return Object.entries(playerSimcMap)
        .map(([name, block]) => sleepingNames.has(name) ? `${block}\nsleeping=1` : block)
        .join('\n\n');
}

// SimC's own built-in defaults when these aren't specified — confirmed via
// the "Simulating..." line it prints at startup (fight_style=None,
// max_time=300, vary_combat_length=0.20, optimal_raid=1). Passed explicitly
// now so a future SimC version can't silently change what we're actually
// simulating, and so every result can report exactly what fight it used.
// Overridable per-call for when different sim types (fight styles, lengths)
// are needed later.
//
// fight_style=None isn't actually a settable value — it's SimC's internal
// label for "nothing was specified" and the CLI rejects it (confirmed:
// "Invalid fight style 'None'"). Patchwerk (simple tank-and-spank) is the
// closest real, named equivalent to what running unset practically
// simulates, so that's what's locked in here instead.
const DEFAULT_FIGHT_STYLE = 'Patchwerk';
const DEFAULT_MAX_TIME = 300;
const DEFAULT_VARY_COMBAT_LENGTH = 0.2;
const DEFAULT_OPTIMAL_RAID = 1;

async function runSimc(simcData, options = {}) {
    const tempId = crypto.randomUUID();
    const tempDir = os.tmpdir();
    const skipHtml = !!options.skipHtml;

    const simcInputPath = path.join(tempDir, `input_${tempId}.simc`);
    const jsonOutputPath = path.join(tempDir, `output_${tempId}.json`);
    const htmlId = options.reportId ? String(options.reportId).replace(/[^a-zA-Z0-9-]/g, '') : tempId;
    const htmlOutputPath = skipHtml ? null : path.join(reportsDir, `${htmlId}.html`);

    const iterations = options.iterations || 1;
    const targetError = options.targetError;
    const threads = options.threads || 1;
    const statisticsLevel = options.statisticsLevel ?? 0;
    const seed = options.seed;
    const fightStyle = options.fightStyle || DEFAULT_FIGHT_STYLE;
    const maxTime = options.maxTime ?? DEFAULT_MAX_TIME;
    const varyCombatLength = options.varyCombatLength ?? DEFAULT_VARY_COMBAT_LENGTH;
    const optimalRaid = options.optimalRaid ?? DEFAULT_OPTIMAL_RAID;
    const binary = getSimcBinaryPath();
    const jsonOutputDir = path.dirname(jsonOutputPath);

    if (!binary || !fs.existsSync(binary)) {
        throw new Error(
            `SimC binary not found at '${binary}'. ` +
            `Verify that the build succeeded and set SIMC_PATH to the absolute executable path if needed.`
        );
    }

    console.log(`SimC binary resolved to: ${binary}`);
    console.log(`Ensuring SimC output directories exist: json=${jsonOutputDir}${skipHtml ? '' : `, html=${path.dirname(htmlOutputPath)}`}`);

    try {
        await fsPromises.mkdir(jsonOutputDir, { recursive: true });
        if (!skipHtml) await fsPromises.mkdir(path.dirname(htmlOutputPath), { recursive: true });
        await fsPromises.writeFile(simcInputPath, simcData.combinedSimcText, 'utf-8');

        const args = [
            simcInputPath,
            `json2=${jsonOutputPath}`,
            `iterations=${iterations}`,
            `threads=${threads}`,
            `statistics_level=${statisticsLevel}`,
            `fight_style=${fightStyle}`,
            `max_time=${maxTime}`,
            `vary_combat_length=${varyCombatLength}`,
            `optimal_raid=${optimalRaid}`
        ];
        // Batch/backlog runs skip the html report entirely — at thousands-of-
        // pulls scale, writing a multi-MB report per run would blow up disk
        // for no reader. Only on-demand (Mode 2) requests get a real report.
        if (!skipHtml) args.push(`html=${htmlOutputPath}`);
        // target_error causes SimC to keep running past `iterations` until it
        // converges to that error target, which fights a fixed batch size —
        // only pass it when a caller explicitly wants convergence-based sims.
        if (targetError) args.push(`target_error=${targetError}`);
        if (seed) args.push(`seed=${seed}`);

        console.log(`Starting SimC run: binary=${binary}, iterations=${iterations}, target_error=${targetError || '(none)'}, threads=${threads}, statistics_level=${statisticsLevel}, fight_style=${fightStyle}, max_time=${maxTime}, vary_combat_length=${varyCombatLength}, optimal_raid=${optimalRaid}, seed=${seed || '(random)'}, skipHtml=${skipHtml}`);

        await new Promise((resolve, reject) => {
            const child = spawn(binary, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: 1000 * 60 * 8
            });
            currentChild = child;

            let stdout = '';
            let stderr = '';

            child.stdout.on('data', (chunk) => {
                stdout += chunk.toString();
            });

            child.stderr.on('data', (chunk) => {
                stderr += chunk.toString();
            });

            child.on('error', (error) => {
                currentChild = null;
                console.error(`SimC spawn error: ${error.message}`);
                reject(new Error(`SimC spawn failed: ${error.message}`));
            });

            child.on('close', (code, signal) => {
                currentChild = null;
                console.log(`SimC process closed: code=${code}, signal=${signal}`);
                if (stdout) {
                    console.log(`SimC stdout length=${stdout.length}`);
                }
                if (stderr) {
                    console.error(`SimC stderr: ${stderr}`);
                }
                if (signal) {
                    // Killed via cancelCurrentSim() (a priority request preempting
                    // this run) or an external signal — not a real crash.
                    return reject(new Error(`SimC run was cancelled (signal=${signal})`));
                }
                if (code !== 0) {
                    const errorDetails = [];
                    if (stderr) errorDetails.push(`stderr=${stderr.trim()}`);
                    if (stdout) errorDetails.push(`stdout=${stdout.trim()}`);
                    return reject(new Error(
                        `SimC binary execution failed (${binary}): exit code ${code}` +
                        (errorDetails.length ? ` | ${errorDetails.join(' | ')}` : '')
                    ));
                }
                resolve(stdout);
            });
        });

        const rawJson = await fsPromises.readFile(jsonOutputPath, 'utf-8');
        const parsedJson = JSON.parse(rawJson);

        const players = (parsedJson?.sim?.players || []).map(p => {
            const meta = simcData.playerMeta?.[p.name.toLowerCase()] || {};

            const gearItems = Object.values(p.gear || {}).filter(item => item && typeof item.ilevel === 'number');
            const ilevel = gearItems.length
                ? Math.round(gearItems.reduce((sum, item) => sum + item.ilevel, 0) / gearItems.length)
                : null;

            return {
                name: p.name,
                realm: meta.realm ?? null,
                class: meta.class ?? null,
                spec: meta.spec ?? null,
                ilevel,
                dps: Math.round(p.collected_data?.dps?.mean || p.dps?.mean || 0)
            };
        });

        const totalDps = players.reduce((sum, p) => sum + p.dps, 0);

        return {
            reportId: skipHtml ? null : htmlId,
            reportUrl: skipHtml ? null : `/api/get-simc?report=${htmlId}`,
            iterations,
            fightStyle,
            maxTime,
            varyCombatLength,
            optimalRaid,
            totalDps,
            playerCount: players.length,
            players
        };

    } finally {
        await fsPromises.unlink(simcInputPath).catch(() => {});
        await fsPromises.unlink(jsonOutputPath).catch(() => {});
    }
}

// Runs at most one SimC process at a time so concurrent requests / background
// batches don't stack their memory footprints on top of each other. Shared
// as a module singleton (Node caches require()d modules) between the request
// handler and the background worker.
let simcQueueTail = Promise.resolve();
let currentChild = null;

function enqueueSimc(task) {
    const resultPromise = simcQueueTail.then(task, task);
    simcQueueTail = resultPromise.then(() => {}, () => {});
    return resultPromise;
}

// Kills whatever SimC process is currently running, if any. The killed run's
// promise rejects (see the `close` handler above), which the background
// worker already treats as a failed cycle — it discards the partial batch
// and quietly retries at the next tick, so no extra bookkeeping is needed here.
function cancelCurrentSim() {
    if (!currentChild) return false;
    try {
        currentChild.kill();
        return true;
    } catch (e) {
        return false;
    }
}

// For on-demand requests that should jump ahead of (and cancel) whatever
// background batch is currently running, rather than queue behind it.
function enqueueSimcPriority(task) {
    cancelCurrentSim();
    return enqueueSimc(task);
}

module.exports = {
    getRecentPullId,
    getAllPulls,
    getRaidRankings,
    getSimcPull,
    buildCombinedSimcText,
    runSimc,
    enqueueSimc,
    enqueueSimcPriority,
    cancelCurrentSim,
    reportsDir,
    getSimcBinaryPath
};
