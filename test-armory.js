require('dotenv').config({ path: '.env.local' });

const clientId = process.env.BLIZZARD_CLIENT_ID;
const clientSecret = process.env.BLIZZARD_CLIENT_SECRET;

async function testArmory() {
    console.log("1. Testing Blizzard OAuth Token...");
    
    if (!clientId || !clientSecret) {
        console.error("❌ Credentials missing from .env.local!");
        return;
    }

    try {
        // Step 1: Get Access Token
        const auth = Buffer.from(`${clientId.trim()}:${clientSecret.trim()}`).toString('base64');
        const tokenRes = await fetch('https://eu.battle.net/oauth/token', {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'grant_type=client_credentials'
        });

        if (!tokenRes.ok) {
            console.error("❌ Token Request Failed:", await tokenRes.text());
            return;
        }

        const { access_token } = await tokenRes.json();
        console.log("✅ Token acquired successfully!");

        // Step 2: Fetch Equipment for a specific character
        const region = "eu";
        const realm = "tarren-mill";
        const characterName = "gingi"; // <--- CHANGE THIS to any player in the raid with the BoE!

        console.log(`2. Fetching equipment for ${characterName}-${realm}...`);

        const equipUrl = `https://${region}.api.blizzard.com/profile/wow/character/${realm}/${characterName}/equipment?namespace=profile-${region}&locale=en_US`;

        const equipRes = await fetch(equipUrl, {
            headers: { 'Authorization': `Bearer ${access_token}` }
        });

        if (!equipRes.ok) {
            console.error("❌ Equipment Fetch Failed:", await equipRes.text());
            return;
        }

        const data = await equipRes.json();
        console.log(`✅ Success! Retrieved ${data.equipped_items.length} equipped items.`);

        // Step 3: Print the Feet item (Fading Dawn Sabatons)
        const feetItem = data.equipped_items.find(item => item.slot.type === "FEET");
        
        console.log("\n--- FEET ITEM RAW DATA ---");
        console.log(JSON.stringify(feetItem, null, 2));

    } catch (err) {
        console.error("❌ Unexpected Error:", err.message);
    }
}

testArmory();