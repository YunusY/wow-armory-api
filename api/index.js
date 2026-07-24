require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

// In-memory token cache
let tokenCache = {
  accessToken: null,
  expiresAt: 0,
};

async function getBlizzardToken() {
  const now = Date.now();

  // Reuse active token if valid (with 60s buffer)
  if (tokenCache.accessToken && tokenCache.expiresAt > now + 60000) {
    return tokenCache.accessToken;
  }

  const clientId = process.env.BLIZZARD_CLIENT_ID;
  const clientSecret = process.env.BLIZZARD_CLIENT_SECRET;
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch('https://us.battle.net/oauth/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    throw new Error(`Auth failed with status ${response.status}`);
  }

  const data = await response.json();
  
  tokenCache.accessToken = data.access_token;
  tokenCache.expiresAt = now + (data.expires_in * 1000);

  return tokenCache.accessToken;
}

// Route: GET /api/character/:region/:realm/:name
app.get('/api/character/:region/:realm/:name', async (req, res) => {
  try {
    const { region, realm, name } = req.params;

    const realmSlug = realm.toLowerCase().trim().replace(/\s+/g, '-').replace(/'/g, '');
    const characterName = name.toLowerCase().trim();
    const regionLower = region.toLowerCase();

    const accessToken = await getBlizzardToken();
    const blizzardUrl = `https://${regionLower}.api.blizzard.com/profile/wow/character/${realmSlug}/${characterName}?namespace=profile-${regionLower}&locale=en_US`;

    const apiResponse = await fetch(blizzardUrl, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });

    if (!apiResponse.ok) {
      if (apiResponse.status === 404) {
        return res.status(404).json({ error: 'Character not found' });
      }
      return res.status(apiResponse.status).json({ error: 'Blizzard API Error' });
    }

    const data = await apiResponse.json();

    return res.json({
      name: data.name,
      realm: data.realm.name,
      level: data.level,
      class: data.character_class.name,
      race: data.race.name,
      itemLevel: data.equipped_item_level,
      guild: data.guild ? data.guild.name : null,
    });

  } catch (error) {
    console.error('Server error:', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = app;