const https = require('https');
const dns = require('dns');

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

const guild_ids = {
    "echo": "1047044",
    "liquid": "1712677"
};

const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json"
};

let blizzardToken = null;
let tokenExpiry = 0;

// Step 1: Get OAuth Token using native IPv4 socket
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
            family: 4, // IPv4 socket override
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

// Step 2: Fetch Equipment using native IPv4 socket
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
            family: 4, // IPv4 socket override
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

// Step 3: Extract & Sort Secondary Stats (Crit=32, Haste=36, Vers=40, Mastery=49)
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

    // Sort descending by value (Major stat first)
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
    
    // STEP A: IDENTIFY PLAYERS WITH BoE ITEMS
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

    // STEP B: FETCH BLIZZARD ARMORY CONCURRENTLY
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

    // STEP C: BUILD MASTER SIMC TEXT
    let combinedSimcText = "";

    for (let i = 0; i < 20; i++) {
        if (!data.details.roster[i]) break; 
        const p = data.details.roster[i].character;

        let simc = `${p.class.slug.replaceAll("-", "")}=${p.name}\nlevel=90\nrace=${p.race.slug.replaceAll("-", "_")}\nspec=${p.spec.name.toLowerCase().replaceAll("-", "_")}\ntalents=${p.talentLoadout.exportLoadoutText}\n`;
        const items = p.items.items;

        for (const slot of slots) {
            const item = items[slot];
            if (item) {
                const itemName = item.name.replace(/'/g, "").replace(/ /g, "_");
                const isBoe = boeItems.some(boe => itemName.toLowerCase().includes(boe));

                if (slot === "mainhand" || slot === "offhand") {
                    simc += `${slot === "mainhand" ? "main_hand" : "off_hand"}=${itemName},id=${item.item_id}`;
                } else {
                    simc += `${slot}=${itemName},id=${item.item_id}`;
                }

                if (item.enchant) simc += `,enchant_id=${item.enchant}`;
                if (item.gems && item.gems.length > 0) simc += `,gem_id=${item.gems.join("/")}`;
                
                let bonusStr = item.bonuses && item.bonuses.length > 0 ? item.bonuses.join("/") : "";
                if (bonusStr) simc += `,bonus_id=${bonusStr}`;

                // Parse EXACT stats directly from Armory
                if (isBoe && armoryData[i]) {
                    const baseSlot = slot.replace(/\d+$/, "").toUpperCase();
                    const armoryItem = armoryData[i].find(ai => 
                        String(ai.item?.id) === String(item.item_id) || 
                        ai.slot?.type === baseSlot
                    );

                    const craftedStats = extractCraftedStats(armoryItem);
                    if (craftedStats) {
                        simc += `,crafted_stats=${craftedStats}`;
                    }
                }

                simc += "\n";
            }
        }
        combinedSimcText += simc + "\n\n";
    }
    
    return combinedSimcText.trim();
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        const clean = (val) => (val === 'undefined' || val === 'null' || val === '') ? undefined : val;
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

        const guild_id = guild_ids[guild?.toLowerCase()];
        if (!guild_id) {
            return res.status(400).json({ 
                error: `Guild '${guild}' is not found in predefined guild_ids.` 
            });
        }

        if (!pullId) {
            pullId = await getRecentPullId(raid, boss, difficulty, region, realm, guild, period);
        }

        const simcText = await getSimcPull(raid, boss, difficulty, region, realm, guild, guild_id, pullId);

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.status(200).send(simcText);

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};