const https = require('https');
const dns = require('dns');
const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');

if (dns && dns.setDefaultResultOrder) {
    try { dns.setDefaultResultOrder('ipv4first'); } catch (e) {}
}

const clientId = (process.env.BLIZZARD_CLIENT_ID || '').trim();
const clientSecret = (process.env.BLIZZARD_CLIENT_SECRET || '').trim();

// Hardcoded BoE list
const boeItems = [
    "primal_spark_pauldrons",
    "power_stance_breeches",
    "visage_of_unseen_truths",
    "infernal_greatlock_girdle",
    "nullstriders_boots",
    "raging_storm_sash",
    "fading_dawn_sabatons",
    "breastplate_of_the_final_defense"
];

const healerSpecs = ["restoration", "holy", "preservation", "mistweaver", "discipline"];

const guild_ids = {
    "echo": "1047044",
    "liquid": "1712677"
};

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
                const rawName = items[slot].name.toLowerCase();
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

    for (let i = 0; i < 20; i++) {
        if (!data.details.roster[i]) break; 
        const p = data.details.roster[i].character;

        const cleanClass = p.class.slug.toLowerCase().replace(/[^a-z0-9]/g, "");
        const cleanRace = p.race.slug.toLowerCase().replace(/[\s-]+/g, "_");
        const cleanSpec = p.spec.name.toLowerCase().trim().replace(/[\s-]+/g, "_");

        const isHealer = (p.spec.role && p.spec.role.toLowerCase() === 'healer') || healerSpecs.includes(cleanSpec);
        if (isHealer) continue;

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
        combinedSimcText += playerSimc + "\n\n";
    }
    
    return {
        combinedSimcText: combinedSimcText.trim(),
        playerSimcMap
    };
}

async function runSimc(simcData, options = {}) {
    const uniqueId = crypto.randomUUID();
    const tempDir = os.tmpdir();

    const simcInputPath = path.join(tempDir, `input_${uniqueId}.simc`);
    const jsonOutputPath = path.join(tempDir, `output_${uniqueId}.json`);
    const htmlOutputPath = path.join(reportsDir, `${uniqueId}.html`);

    const iterations = options.iterations || 1500;
    const targetError = options.targetError || 0.2;
    const binary = getSimcBinaryPath();

    if (!binary || !fs.existsSync(binary)) {
        throw new Error(
            `SimC binary not found at '${binary}'. ` +
            `Verify that the build succeeded and set SIMC_PATH to the absolute executable path if needed.`
        );
    }

    console.log(`SimC binary resolved to: ${binary}`);

    try {
        // FIXED TYPO HERE ('utf-8')
        await fsPromises.writeFile(simcInputPath, simcData.combinedSimcText, 'utf-8');

        const args = [
            simcInputPath,
            `json2=${jsonOutputPath}`,
            `html=${htmlOutputPath}`,
            `iterations=${iterations}`,
            `target_error=${targetError}`
        ];

        console.log(`Starting SimC run: binary=${binary}, iterations=${iterations}, target_error=${targetError}`);

        await new Promise((resolve, reject) => {
            const child = spawn(binary, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: 1000 * 60 * 8
            });

            let stdout = '';
            let stderr = '';

            child.stdout.on('data', (chunk) => {
                stdout += chunk.toString();
            });

            child.stderr.on('data', (chunk) => {
                stderr += chunk.toString();
            });

            child.on('error', (error) => {
                console.error(`SimC spawn error: ${error.message}`);
                reject(new Error(`SimC spawn failed: ${error.message}`));
            });

            child.on('close', (code, signal) => {
                console.log(`SimC process closed: code=${code}, signal=${signal}`);
                if (stdout) {
                    console.log(`SimC stdout length=${stdout.length}`);
                }
                if (stderr) {
                    console.error(`SimC stderr: ${stderr}`);
                }
                if (code !== 0) {
                    return reject(new Error(`SimC binary execution failed (${binary}): exit code ${code} signal ${signal}`));
                }
                resolve(stdout);
            });
        });

        const rawJson = await fsPromises.readFile(jsonOutputPath, 'utf-8');
        const parsedJson = JSON.parse(rawJson);

        const players = (parsedJson?.sim?.players || []).map(p => ({
            name: p.name,
            spec: p.spec,
            class: p.class,
            dps: Math.round(p.collected_data?.dps?.mean || p.dps?.mean || 0)
        }));

        const totalDps = players.reduce((sum, p) => sum + p.dps, 0);

        return {
            reportId: uniqueId,
            reportUrl: `/api/get-simc?report=${uniqueId}`,
            iterations,
            totalDps,
            playerCount: players.length,
            players
        };

    } finally {
        await fsPromises.unlink(simcInputPath).catch(() => {});
        await fsPromises.unlink(jsonOutputPath).catch(() => {});
    }
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        const clean = (val) => (val === 'undefined' || val === 'null' || val === '') ? undefined : val;

        // -------------------------------------------------------------
        // NEW FIX: Serve HTML Report if `?report=<ID>` parameter exists
        // -------------------------------------------------------------
        let reportId = clean(req.query.report);
        if (reportId) {
            // Prevent directory traversal attacks
            const safeReportId = path.basename(reportId).replace(/[^a-zA-Z0-9-]/g, '');
            const htmlPath = path.join(reportsDir, `${safeReportId}.html`);

            if (fs.existsSync(htmlPath)) {
                const htmlContent = await fsPromises.readFile(htmlPath, 'utf-8');
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                return res.status(200).send(htmlContent);
            } else {
                return res.status(404).json({ error: 'Report not found or expired.' });
            }
        }

        // -------------------------------------------------------------
        // Standard Sim Generation Flow
        // -------------------------------------------------------------
        let raid = clean(req.query.raid);
        let boss = clean(req.query.boss);
        let difficulty = clean(req.query.difficulty);
        let region = clean(req.query.region);
        let realm = clean(req.query.realm);
        let guild = clean(req.query.guild);
        let period = clean(req.query.period);
        let pullId = clean(req.query.pullId);

        let runSim = req.query.sim === 'true' || 
             req.query.simc === 'true' || 
             req.query.sim === '1' || 
             req.query.simc === '1' || 
             req.query.format === 'html';

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

        const guild_id = guild_ids[guild?.toLowerCase()];
        if (!guild_id) {
            return res.status(400).json({ 
                error: `Guild '${guild}' is not found in predefined guild_ids.` 
            });
        }

        if (!pullId) {
            pullId = await getRecentPullId(raid, boss, difficulty, region, realm, guild, period);
        }

        const simcData = await getSimcPull(raid, boss, difficulty, region, realm, guild, guild_id, pullId);

        if (runSim) {
            const simResults = await runSimc(simcData, {
                iterations: Number(req.query.iterations) || 1500,
                targetError: Number(req.query.target_error) || 0.2
            });

            return res.status(200).json(simResults);
        }

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.status(200).send(simcData.combinedSimcText);

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};