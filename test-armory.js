require('dotenv').config({ path: '.env.local' });
const https = require('https');

async function testBlizzardArmory() {
    console.log("=========================================");
    console.log("BLIZZARD ARMORY DIRECT CHARACTER TEST");
    console.log("=========================================");

    const clientId = (process.env.BLIZZARD_CLIENT_ID || '').trim();
    const clientSecret = (process.env.BLIZZARD_CLIENT_SECRET || '').trim();

    if (!clientId || !clientSecret) {
        console.error("\n❌ Credentials missing from .env.local!");
        return;
    }

    // 1. Get OAuth Token
    console.log("[1/3] Authenticating with Blizzard...");
    const token = await getToken(clientId, clientSecret);
    console.log(`      ✅ Token Acquired! (${token.substring(0, 12)}...)`);

    // 2. Query Echo's active raid characters from Raider.IO
    console.log("\n[2/3] Fetching active Echo roster from Raider.IO...");
    const rioUrl = "https://raider.io/api/v1/live-tracking/guild/raid-comps?raid=amirdrassil-the-dreams-hope&difficulty=mythic&id=1047044&guild_id=1047044&region=eu&realm=tarren-mill&boss=fyrakk-the-blazing&guild=echo";
    
    let testList = [
        { name: "clickles", realm: "tarren-mill" },
        { name: "scrype", realm: "tarren-mill" },
        { name: "meevix", realm: "tarren-mill" }
    ];

    try {
        const rioRes = await fetch(rioUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (rioRes.ok) {
            const rioData = await rioRes.json();
            const roster = rioData.details?.roster || [];
            if (roster.length > 0) {
                console.log(`      ✅ Found ${roster.length} active players in roster.`);
                testList = roster.slice(0, 5).map(r => ({
                    name: r.character.name,
                    realm: (r.character.realm && r.character.realm.slug) ? r.character.realm.slug : "tarren-mill"
                }));
            }
        }
    } catch (e) {}

    // 3. Query Armory for the active characters
    console.log(`\n[3/3] Querying Blizzard Armory Equipment...`);
    
    for (const target of testList) {
        console.log(`\nTesting ${target.name}-${target.realm}...`);
        const success = await fetchEquipment(token, target.realm, target.name);
        if (success) {
            console.log("\n=========================================");
            console.log("🎉 SUCCESS! 100% WORKING ARMORY CONNECTION!");
            console.log("=========================================\n");
            break;
        }
    }
}

function getToken(id, secret) {
    return new Promise((resolve, reject) => {
        const auth = Buffer.from(`${id}:${secret}`).toString('base64');
        const postData = 'grant_type=client_credentials';
        const req = https.request({
            hostname: 'eu.battle.net',
            path: '/oauth/token',
            method: 'POST',
            family: 4,
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData),
                'User-Agent': 'Mozilla/5.0'
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) resolve(JSON.parse(data).access_token);
                else reject(new Error(`OAuth HTTP ${res.statusCode}: ${data}`));
            });
        });
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

function fetchEquipment(token, realm, character) {
    return new Promise((resolve) => {
        const realmSlug = encodeURIComponent(realm.toLowerCase().replace(/'/g, '').replace(/\s+/g, '-'));
        const nameSlug = encodeURIComponent(character.toLowerCase());

        const req = https.request({
            hostname: 'eu.api.blizzard.com',
            path: `/profile/wow/character/${realmSlug}/${nameSlug}/equipment?namespace=profile-eu&locale=en_US`,
            method: 'GET',
            family: 4,
            headers: {
                'Authorization': `Bearer ${token}`,
                'User-Agent': 'Mozilla/5.0'
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    const parsed = JSON.parse(data);
                    console.log(`  ✅ SUCCESS! HTTP 200 OK - Found ${parsed.equipped_items?.length} items.`);
                    
                    const feet = parsed.equipped_items?.find(i => i.slot?.type === "FEET");
                    console.log(`  Feet Item Name: "${feet?.name || 'None'}"`);
                    if (feet && feet.stats) {
                        console.log("\n  Feet Item Stats Array:");
                        console.log(JSON.stringify(feet.stats, null, 2));
                    }
                    resolve(true);
                } else {
                    console.log(`  ❌ HTTP ${res.statusCode}: ${character}-${realmSlug} not found on Blizzard API.`);
                    resolve(false);
                }
            });
        });
        req.on('error', () => resolve(false));
        req.end();
    });
}

testBlizzardArmory();