const https = require('https');

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

// SimC crafted_stats tokens (32=Crit, 36=Haste, 40=Vers, 49=Mastery)
const stat_bonus_ids = { 
    "crit haste": "32/36", "crit mastery": "32/49", "crit versa": "32/40", 
    "haste crit": "36/32", "haste mastery": "36/49", "haste versa": "36/40", 
    "mastery crit": "49/32", "mastery haste": "49/36", "mastery versa": "49/40", 
    "versa crit": "40/32", "versa haste": "40/36", "versa mastery": "40/49" 
};

const spec_stat_choices = {
    "mage-frost": "crit mastery", "paladin-retribution": "crit mastery",
    "warrior-protection": "crit haste", "druid-guardian": "haste mastery",
    "deathknight-unholy": "crit mastery", "hunter-marksmanship": "crit mastery",
    "priest-shadow": "mastery haste", "rogue-subtlety": "crit mastery",
    "shaman-elemental": "crit mastery", "warlock-demonology": "crit haste",
    "monk-windwalker": "haste crit", "evoker-augmentation": "crit haste",
    "demonhunter-devourer": "haste mastery"
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

// Fetch OAuth token cleanly using native HTTPS
async function getBlizzardToken(region = 'eu') {
    if (blizzardToken && Date.now() < tokenExpiry) return blizzardToken;
    if (!clientId || !clientSecret) return null;
    
    const cleanRegion = (region || 'eu').toLowerCase();
    const tokenHost = ['eu', 'us', 'kr', 'tw'].includes(cleanRegion) ? `${cleanRegion}.battle.net` : 'oauth.battle.net';
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const bodyData = 'grant_type=client_credentials';

    return new Promise((resolve) => {
        const req = https.request({
            hostname: tokenHost,
            path: '/oauth/token',
            method: 'POST',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(bodyData),
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
        req.write(bodyData);
        req.end();
    });
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

    // --- STEP B: FETCH BLIZZARD ARMORY CONCURRENTLY ---
    const armoryData = {};

    if (playersToFetch.length > 0) {
        const cleanRegion = (region || "eu").toLowerCase();
        const token = await getBlizzardToken(cleanRegion);
        
        if (token) {
            await Promise.all(playersToFetch.map(async (player) => {
                try {
                    const realmSlug = encodeURIComponent(player.realm.toLowerCase().replace(/'/g, '').replace(/\s+/g, '-'));
                    const nameSlug = encodeURIComponent(player.name.toLowerCase());
                    
                    const bUrl = `https://${cleanRegion}.api.blizzard.com/profile/wow/character/${realmSlug}/${nameSlug}/equipment?namespace=profile-${cleanRegion}&locale=en_US`;
                    const armoryResponse = await fetch(bUrl, { headers: { ...headers, 'Authorization': `Bearer ${token}` } });
                    
                    if (armoryResponse.ok) {
                        const eq = await armoryResponse.json();
                        if (eq.equipped_items) armoryData[player.index] = eq.equipped_items;
                    }
                } catch (err) {}
            }));
        }
    }

    // --- STEP C: BUILD MASTER SIMC STRING ---
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

                // Handle BoE Crafted Stats (Armory First -> Spec Choice Second)
                if (isBoe) {
                    let craftedStatsStr = null;

                    // 1. Try Blizzard Armory
                    if (armoryData[i]) {
                        const baseSlot = slot.replace(/\d+$/, "").toUpperCase();
                        const armoryItem = armoryData[i].find(ai => 
                            String(ai.item?.id) === String(item.item_id) || 
                            ai.slot?.type === baseSlot
                        );

                        if (armoryItem && armoryItem.stats) {
                            const secStats = armoryItem.stats.filter(s =>
                                ["CRITICAL_STRIKE", "HASTE", "MASTERY", "VERSATILITY"].includes(s.type?.type)
                            );
                            
                            secStats.sort((a, b) => b.value - a.value);
                            
                            if (secStats.length > 0) {
                                const statMap = { 
                                    "CRITICAL_STRIKE": "32", 
                                    "HASTE": "36", 
                                    "VERSATILITY": "40",
                                    "MASTERY": "49" 
                                };
                                craftedStatsStr = secStats.map(s => statMap[s.type.type]).join("/");
                            }
                        }
                    }

                    // 2. Fallback to Spec Choice if Armory is unavailable
                    if (!craftedStatsStr) {
                        const classspec = `${p.class.slug.replaceAll("-", "")}-${p.spec.name.toLowerCase().replaceAll("-", "_")}`;
                        const statChoice = spec_stat_choices[classspec];
                        if (statChoice && stat_bonus_ids[statChoice]) {
                            craftedStatsStr = stat_bonus_ids[statChoice];
                        }
                    }

                    if (craftedStatsStr) {
                        simc += `,crafted_stats=${craftedStatsStr}`;
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