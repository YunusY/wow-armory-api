require('dotenv').config({ path: '.env.local' });
const https = require('https');

const clientId = (process.env.BLIZZARD_CLIENT_ID || '').trim();
const clientSecret = (process.env.BLIZZARD_CLIENT_SECRET || '').trim();

console.log("=== BLIZZARD API NETWORK DIAGNOSTIC ===");
console.log("BLIZZARD_CLIENT_ID present:", !!clientId);
console.log("BLIZZARD_CLIENT_SECRET present:", !!clientSecret);

if (!clientId || !clientSecret) {
    console.error("❌ ERROR: BLIZZARD_CLIENT_ID or BLIZZARD_CLIENT_SECRET is missing from .env.local!");
    process.exit(1);
}

const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
const body = 'grant_type=client_credentials';

async function testEndpoint(name, hostname, path) {
    console.log(`\nTesting [${name}] -> https://${hostname}${path}`);
    
    // Test 1: Native Node https module
    await new Promise((resolve) => {
        const start = Date.now();
        const req = https.request({
            hostname: hostname,
            path: path,
            method: 'POST',
            timeout: 5000,
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body)
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const duration = Date.now() - start;
                if (res.statusCode === 200) {
                    const token = JSON.parse(data).access_token;
                    console.log(`  ✅ HTTPS Module: SUCCESS (${duration}ms)! Token acquired.`);
                } else {
                    console.log(`  ❌ HTTPS Module: HTTP ${res.statusCode} (${duration}ms) - ${data}`);
                }
                resolve();
            });
        });

        req.on('timeout', () => {
            req.destroy();
            console.log(`  ❌ HTTPS Module: TIMEOUT (5000ms) - Cannot reach ${hostname}:443`);
            resolve();
        });

        req.on('error', (err) => {
            console.log(`  ❌ HTTPS Module: ERROR (${err.code || err.message})`);
            resolve();
        });

        req.write(body);
        req.end();
    });

    // Test 2: Native fetch
    try {
        const start = Date.now();
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const res = await fetch(`https://${hostname}${path}`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: body,
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        const duration = Date.now() - start;

        if (res.ok) {
            const data = await res.json();
            console.log(`  ✅ Fetch API: SUCCESS (${duration}ms)! Token acquired.`);
        } else {
            console.log(`  ❌ Fetch API: HTTP ${res.status} (${duration}ms) - ${await res.text()}`);
        }
    } catch (err) {
        console.log(`  ❌ Fetch API: ERROR (${err.name === 'AbortError' ? 'TIMEOUT (5000ms)' : err.message})`);
    }
}

async function run() {
    await testEndpoint("Global Domain", "oauth.battle.net", "/token");
    await testEndpoint("EU Domain", "eu.battle.net", "/oauth/token");
    await testEndpoint("US Domain", "us.battle.net", "/oauth/token");
    console.log("\n=======================================");
}

run();