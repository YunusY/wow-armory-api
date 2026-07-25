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
    "breastplate_of_the_final_defense" // Fixed the space here
];

const stat_bonus_ids = {
    "crit haste": "32:36", "crit mastery": "32:49", "crit versa": "32:40",
    "haste crit": "36:32", "haste mastery": "36:49", "haste versa": "36:40",
    "mastery crit": "49:32", "mastery haste": "49:36", "mastery versa": "49:40",
    "versa crit": "40:32", "versa haste": "40:36", "versa mastery": "40:49"
};

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
    tokenExpiry = Date.now() + (data.expires_in - 60) * 1000; 
    
    return blizzardToken;
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
    
    // --- STEP A: IDENTIFY PLAYERS WITH BoE ITEMS ---
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

    // --- STEP B: FETCH BLIZZARD ARMORY ---
    const armoryData = {};
    if (playersToFetch.length > 0) {
        const token = await getBlizzardToken();
        
        await Promise.all(playersToFetch.map(async (player) => {
            try {
                const realmSlug = encodeURIComponent(player.realm.toLowerCase().replace(/'/g, '').replace(/\s+/g, '-'));
                const nameSlug = encodeURIComponent(player.name.toLowerCase());
                
                const bUrl = `https://${region}.api.blizzard.com/profile/wow/character/${realmSlug}/${nameSlug}/equipment?namespace=profile-${region}&locale=en_US`;
                const armoryResponse = await fetch(bUrl, { headers: { 'Authorization': `Bearer ${token}` } });
                
                if (armoryResponse.ok) {
                    const eq = await armoryResponse.json();
                    if (eq.equipped_items) armoryData[player.index] = eq.equipped_items;
                }
            } catch (err) {
                console.error(`Armory error for ${player.name}:`, err);
            }
        }));
    }

    // --- STEP C: BUILD MASTER SIMC STRING ---
    let combinedSimcText = "";

    for (let i = 0; i < 20; i++) {
        if (!data.details.roster[i]) break; 
        const p = data.details.roster[i].character;

        let simc = `${p.class.slug.replaceAll("-", "")}=${p.name}\nlevel=90\nrace=${p.race.slug.replaceAll("-", "_")}\nspec=${p.spec.name.toLowerCase().replaceAll("-", "_")}\ntalents=${p.talentLoadout.exportLoadoutText}\n`;
        const items = p.items.items;
        let secondstats = "inc\n";
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

                // Look up real stats from Armory to append to the bonus list
                if (isBoe && armoryData[i]) {
                    const armoryItem = armoryData[i].find(ai => ai.item.id === item.item_id);
                    console.log("My object:", armoryItem.stats);
                    secondstats+=`\n${armoryItem.stats}\n`;
                    if (armoryItem && armoryItem.stats) {
                        // Filter out secondary stats
                        const secStats = armoryItem.stats.filter(s =>
                            ["CRITICAL_STRIKE", "HASTE", "MASTERY", "VERSATILITY"].includes(s.type.type)
                        );
                        
                        // Sort descending so the stat with the highest allocation is first (Major vs Minor stat)
                        secStats.sort((a, b) => b.value - a.value);
                        
                        if (secStats.length >= 2) {
                            const statMap = { "CRITICAL_STRIKE": "crit", "HASTE": "haste", "MASTERY": "mastery", "VERSATILITY": "versa" };
                            const stat1 = statMap[secStats[0].type.type];
                            const stat2 = statMap[secStats[1].type.type];
                            
                            const statKey = `${stat1} ${stat2}`;
                            const missingBonus = stat_bonus_ids[statKey];
                            
                            // Append the custom stat ID (e.g., /32:36) to the end of the list
                            if (missingBonus) {
                                bonusStr += (bonusStr ? "/" : "") + missingBonus;
                            }
                        }
                    }
                }

                if (bonusStr) simc += `,bonus_id=${bonusStr}`;
                simc += "\n";
                
            }
        }
        combinedSimcText +=  secondstats +simc + "\n\n";
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

        const guild_id = guild_ids[guild?.toLowerCase()];

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