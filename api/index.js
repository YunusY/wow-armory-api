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
];

const stat_bonus_ids = {
    "crit haste": "32:36", "crit mastery": "32:49", "crit versa": "32:40",
    "haste crit": "36:32", "haste mastery": "36:49", "haster versa": "36:40",
    "mastery crit": "49:32", "mastery haste": "49:36", "mastery versa": "49:40",
    "versa crit": "40:32", "versa haste": "40:36", "versa mastery": "40:49"
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

// Generic Headers to prevent Cloudflare / API blocking
const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json"
};

// Helper 1: Get recent pull ID
async function getRecentPullId(raid, boss, difficulty, region, realm, guild, period) {
    const params = new URLSearchParams({
        raid, boss, difficulty, region, realm, guild
    });
    // Only append period if it exists and isn't empty
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

// Helper 2: Get SimC Data
async function getSimcPull(raid, boss, difficulty, region, realm, guild, guild_id, pullId, playerIndex) {
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
    
    if (!data.details || !data.details.roster || !data.details.roster[playerIndex]) {
        throw new Error('Player index out of bounds or roster data missing.');
    }

    const p = data.details.roster[playerIndex].character;

    // 1. ACTOR DECLARATION
    let simc = `${p.class.slug.replaceAll("-", "")}=${p.name}\n`;
    simc += "level=90\n";
    simc += `race=${p.race.slug.replaceAll("-", "_")}\n`;
    simc += `spec=${p.spec.name.toLowerCase().replaceAll("-", "_")}\n`;
    simc += `talents=${p.talentLoadout.exportLoadoutText}\n`;

    // 2. GEAR
    const items = p.items.items;
    const slots = ["head", "neck", "shoulder", "back", "chest", "waist", "wrist", "hands", "legs", "feet", "finger1", "finger2", "trinket1", "trinket2", "mainhand", "offhand"];

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
            if (item.bonuses && item.bonuses.length > 0) simc += `,bonus_id=${item.bonuses.join("/")}`;

            if (boeItems.includes(itemName.toLowerCase())) {
                const classspec = `${p.class.slug.replaceAll("-", "")}-${p.spec.name.toLowerCase().replaceAll("-", "_")}`;
                const missing_stat = stat_bonus_ids[spec_stat_choices[classspec]];
                if (missing_stat) {
                    simc += `/${missing_stat}`;
                }
            }
            simc += "\n";
        }
    }
    return simc;
}

// VERCEL NATIVE HANDLER
module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        // Safe parameter extraction: Strips literal "undefined" or "null" strings
        const clean = (val) => (val === 'undefined' || val === 'null' || val === '') ? undefined : val;

        let raid = clean(req.query.raid);
        let boss = clean(req.query.boss);
        let difficulty = clean(req.query.difficulty);
        let region = clean(req.query.region);
        let realm = clean(req.query.realm);
        let guild = clean(req.query.guild);
        let guild_id = clean(req.query.guild_id);
        let period = clean(req.query.period);
        let pullId = clean(req.query.pullId);
        let playerIndex = clean(req.query.playerIndex);

        // Automatically assign guild_id if it's echo or liquid
        if (!guild_id && guild) {
            guild_id = guild_ids[guild.toLowerCase()];
        }

        // Validation for missing required parameters
        const missingParams = [];
        if (!raid) missingParams.push("raid");
        if (!boss) missingParams.push("boss");
        if (!difficulty) missingParams.push("difficulty");
        if (!region) missingParams.push("region");
        if (!realm) missingParams.push("realm");
        if (!guild) missingParams.push("guild");
        if (!guild_id) missingParams.push("guild_id");
        if (playerIndex === undefined) missingParams.push("playerIndex");

        if (missingParams.length > 0) {
            return res.status(400).json({ 
                error: `Missing required query parameters: ${missingParams.join(", ")}` 
            });
        }

        // Fetch recent pull if no pullId is passed
        if (!pullId) {
            pullId = await getRecentPullId(raid, boss, difficulty, region, realm, guild, period);
        }

        // Generate SIMC profile
        const simcText = await getSimcPull(raid, boss, difficulty, region, realm, guild, guild_id, pullId, parseInt(playerIndex, 10));

        // Return the SIMC text format
        res.setHeader('Content-Type', 'text/plain');
        return res.status(200).send(simcText);

    } catch (error) {
        console.error("Function Error: ", error.message);
        // Expose the error message directly to the front-end
        return res.status(500).json({ error: error.message });
    }
};