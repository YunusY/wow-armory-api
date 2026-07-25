const express = require('express');
const app = express();
const port = 3000;
const guild_ids [
  "echo": "1047044"
  "liquid": "1712677"
]
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
    "haste crit": "36:32", "haste mastery": "36:49", "haster versa": "36:40", // Note: "haster versa" from your original code
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

// Helper 1: Get recent pull ID
async function getRecentPullId(raid, boss, difficulty, region, realm, guild, period) {
    const url = `https://raider.io/api/v1/live-tracking/guild/boss-pulls` +
        `?raid=${encodeURIComponent(raid)}` +
        `&boss=${encodeURIComponent(boss)}` +
        `&difficulty=${encodeURIComponent(difficulty)}` +
        `&region=${encodeURIComponent(region)}` +
        `&realm=${encodeURIComponent(realm)}` +
        `&guild=${encodeURIComponent(guild)}` +
        `&period=${encodeURIComponent(period)}`;

    console.log(`Fetching Pull IDs: ${url}`);
    const response = await fetch(url);
    
    if (!response.ok) throw new Error(`Failed to fetch pull IDs: HTTP ${response.status}`);
    
    const data = await response.json();
    if (!data.pulls || data.pulls.length === 0) throw new Error('No pulls found');
    
    // Returns the most recent pull ID
    return data.pulls[data.pulls.length - 1].details.id;
}

// Helper 2: Get SimC Data
async function getSimcPull(raid, boss, difficulty, region, realm, guild, guild_id, pullId, playerIndex) {
    const url = `https://raider.io/api/v1/live-tracking/guild/raid-comps` +
        `?raid=${encodeURIComponent(raid)}` +
        `&difficulty=${encodeURIComponent(difficulty)}` +
        `&id=${encodeURIComponent(pullId)}` +
        `&guild_id=${encodeURIComponent(guild_id)}` +
        `&region=${encodeURIComponent(region)}` +
        `&realm=${encodeURIComponent(realm)}` +
        `&boss=${encodeURIComponent(boss)}` +
        `&guild=${encodeURIComponent(guild)}`;

    console.log(`Fetching Raid Comp: ${url}`);
    const response = await fetch(url);
    
    if (!response.ok) throw new Error(`Failed to fetch raid comps: HTTP ${response.status}`);
    
    const data = await response.json();
    
    if (!data.details || !data.details.roster || !data.details.roster[playerIndex]) {
        throw new Error('Player index out of bounds or roster data missing');
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

// API Endpoint
app.get('/api/get-simc', async (req, res) => {
    try {
        // Extract query parameters
        const { raid, boss, difficulty, region, realm, guild, guild_id, period, playerIndex } = req.query;
        let { pullId } = req.query;

        // Validation for minimum required parameters
        if (!raid || !boss || !difficulty || !region || !realm || !guild || !guild_id || playerIndex === undefined) {
            return res.status(400).json({ error: "Missing required query parameters." });
        }

        // If pullId isn't provided, fetch the most recent one automatically
        if (!pullId) {
            if (!period) return res.status(400).json({ error: "Provide either pullId or period to fetch the recent pull." });
            pullId = await getRecentPullId(raid, boss, difficulty, region, realm, guild, period);
        }

        // Generate SIMC profile
        const simcText = await getSimcPull(raid, boss, difficulty, region, realm, guild, guild_id, pullId, parseInt(playerIndex, 10));

        // Return the SIMC text format
        res.setHeader('Content-Type', 'text/plain');
        res.send(simcText);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// Start the server
app.listen(port, () => {
    console.log(`SimC API Server running at http://localhost:${port}`);
});