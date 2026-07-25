const clientId = process.env.BLIZZARD_CLIENT_ID;
const clientSecret = process.env.BLIZZARD_CLIENT_SECRET;

// Hardcoded Data
const boeItems = [
    "primal_spark_pauldrons",
    "power_stance_breeches",
    "visage_of_unseen_truths",
    "infernal_greatlock_girdle",
    "nullstriders_boots",
    "raging_storm_sash",
    "fading_dawn_sabatons",
    "breastplate_of_the_final defense"
    // Add your Midnight tier BoEs here if needed!
];

const guild_ids = {
    "echo": "1047044",
    "liquid": "1712677"
};

// Generic Headers to prevent Cloudflare / API blocking
const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json"
};

// Blizzard Token Management
let blizzardToken = null;
let tokenExpiry = 0;

async function getBlizzardToken() {
    if (blizzardToken && Date.now() < tokenExpiry) return blizzardToken;
    if (!clientId || !clientSecret) {
        throw new Error("Missing Blizzard API credentials. Please set BLIZZARD_CLIENT_ID and BLIZZARD_CLIENT_SECRET in Vercel.");
    }
    
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const response = await fetch('https://oauth.battle.net/token', {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials'
    });
    
    if (!response.ok) throw new Error("Failed to authenticate with Blizzard API.");
    
    const data = await response.json();
    blizzardToken = data.access_token;
    // Buffer expiration by 60 seconds to ensure we don't use a token as it expires
    tokenExpiry = Date.now() + (data.expires_in - 60) * 1000; 
    
    return blizzardToken;
}

// Helper 1: Get recent pull ID
async function getRecentPullId(raid, boss, difficulty, region, realm, guild, period) {
    const params = new URLSearchParams({
        raid, boss, difficulty, region, realm, guild
    });
    if (period) params.append('period', period);

    const url = `https://raider.io/api/v1/live-tracking/guild/boss-pulls?${params.toString()}`;
    const response = await fetch(url, { headers });
    
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Raider.IO Boss-Pulls Error: HTTP ${response.status} - ${errorText}`);
    }
    
    const data = await response.json();
    if (!data.pulls || data.pulls.length === 0) throw new Error('No pulls found on Raider.IO for these parameters.');
    
    return data.pulls[data.pulls.length - 1].details.id;
}

// Helper 2: Get SimC Data for All 20 Players
async function getSimcPull(raid, boss, difficulty, region, realm, guild, guild_id, pullId) {
    const params = new URLSearchParams({
        raid, difficulty, id: pullId, guild_id, region, realm, boss, guild
    });

    const url = `https://raider.io/api/v1/live-tracking/guild/raid-comps?${params.toString()}`;
    const response = await fetch(url, { headers });
    
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Raider.IO Raid-Comps Error: HTTP ${response.status} - ${errorText}`);
    }
    
    const data = await response.json();
    if (!data.details || !data.details.roster) {
        throw new Error('Roster data is missing from Raider.IO response.');
    }

    const slots = ["head", "neck", "shoulder", "back", "chest", "waist", "wrist", "hands", "legs", "feet", "finger1", "finger2", "trinket1", "trinket2", "mainhand", "offhand"];
    
    // --- STEP A: IDENTIFY PLAYERS WITH BoE ITEMS ---
    const playersToFetch = [];
    for (let i = 0; i < 20; i++) {
        if (!data.details.roster[i]) break;
        const p = data.details.roster[i].character;
        let hasBoe = false;
        
        const items = p.items.items;
        for (const slot of slots) {
            if (items[slot]) {
                const itemName = items[slot].name.replace(/'/g, "").replace(/ /g, "_").toLowerCase();
                if (boeItems.includes(itemName)) {
                    hasBoe = true;
                    break;
                }
            }
        }
        
        if (hasBoe) {
            // RIO usually stores realm as an object { slug: '...' }, fallback to standard realm if not
            const playerRealm = (p.realm && p.realm.slug) ? p.realm.slug : realm;
            playersToFetch.push({ index: i, name: p.name, realm: playerRealm });
        }
    }

    // --- STEP B: FETCH BLIZZARD ARMORY CONCURRENTLY ---
    const armoryData = {};
    if (playersToFetch.length > 0) {
        const token = await getBlizzardToken();
        
        await Promise.all(playersToFetch.map(async (player) => {
            try {
                const realmSlug = encodeURIComponent(player.realm.toLowerCase().replace(/'/g, '').replace(/\s+/g, '-'));
                const nameSlug = encodeURIComponent(player.name.toLowerCase());
                
                const bUrl = `https://${region}.api.blizzard.com/profile/wow/character/${realmSlug}/${nameSlug}/equipment?namespace=profile-${region}&locale=en_US`;
                const armoryResponse = await fetch(bUrl, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                
                if (armoryResponse.ok) {
                    const eq = await armoryResponse.json();
                    if (eq.equipped_items) {
                        armoryData[player.index] = eq.equipped_items;
                    }
                }
            } catch (err) {
                console.error(`Failed to fetch armory for ${player.name}:`, err);
                // Fails gracefully; if Armory drops the call, we just fallback to RIO stats below
            }
        }));
    }

    // --- STEP C: BUILD MASTER SIMC STRING ---
    let combinedSimcText = "";

    for (let i = 0; i < 20; i++) {
        if (!data.details.roster[i]) break; 

        const p = data.details.roster[i].character;

        // 1. ACTOR DECLARATION
        let simc = `${p.class.slug.replaceAll("-", "")}=${p.name}\n`;
        simc += "level=90\n"; // Note: Might need to bump this to 90 or 100 for Midnight!
        simc += `race=${p.race.slug.replaceAll("-", "_")}\n`;
        simc += `spec=${p.spec.name.toLowerCase().replaceAll("-", "_")}\n`;
        simc += `talents=${p.talentLoadout.exportLoadoutText}\n`;

        // 2. GEAR
        const items = p.items.items;

        for (const slot of slots) {
            const item = items[slot];
            if (item) {
                const itemName = item.name.replace(/'/g, "").replace(/ /g, "_");
                
                if (slot === "mainhand") {
                    simc += `main_hand=${itemName},id=${item.item_id}`;
                } else if (slot === "offhand") {
                    simc += `off_hand=${itemName},id=${item.item_id}`;
                } else {
                    simc += `${slot}=${itemName},id=${item.item_id}`;
                }

                if (item.enchant) simc += `,enchant_id=${item.enchant}`;
                if (item.gems && item.gems.length > 0) simc += `,gem_id=${item.gems.join("/")}`;
                
                // Base bonuses from Raider.IO
                let bonusStr = item.bonuses && item.bonuses.length > 0 ? item.bonuses.join("/") : "";

                // Overwrite with Blizzard Armory bonuses if it is a BoE
                if (boeItems.includes(itemName.toLowerCase()) && armoryData[i]) {
                    const armoryItem = armoryData[i].find(ai => ai.item.id === item.item_id);
                    if (armoryItem && armoryItem.bonus_list) {
                        bonusStr = armoryItem.bonus_list.join("/");
                    }
                }

                if (bonusStr) simc += `,bonus_id=${bonusStr}`;
                simc += "\n";
            }
        }
        
        // Append current player to master string
        combinedSimcText += simc + "\n\n";
    }
    
    return combinedSimcText.trim();
}

// VERCEL NATIVE HANDLER
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

        const guild_id = guild_ids[guild.toLowerCase()];
        if (!guild_id) {
            return res.status(400).json({ 
                error: `Guild '${guild}' is not found in the predefined guild_ids. Supported guilds are: ${Object.keys(guild_ids).join(", ")}` 
            });
        }

        if (!pullId) {
            pullId = await getRecentPullId(raid, boss, difficulty, region, realm, guild, period);
        }

        const simcText = await getSimcPull(raid, boss, difficulty, region, realm, guild, guild_id, pullId);

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.status(200).send(simcText);

    } catch (error) {
        console.error("Function Error: ", error.message);
        return res.status(500).json({ error: error.message });
    }
};