require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { getGuild, listGuilds } = require('../lib/guilds');
const {
  getBossPulls,
  getRaidComp,
  getLatestPullId,
  findLatestPull,
} = require('../lib/raiderio');
const { rosterToSimcExports } = require('../lib/simc');

const app = express();

app.use(cors());
app.use(express.json());

let tokenCache = {
  accessToken: null,
  expiresAt: 0,
};

async function getBlizzardToken() {
  const now = Date.now();

  if (tokenCache.accessToken && tokenCache.expiresAt > now + 60000) {
    return tokenCache.accessToken;
  }

  const clientId = process.env.BLIZZARD_CLIENT_ID;
  const clientSecret = process.env.BLIZZARD_CLIENT_SECRET;
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch('https://us.battle.net/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    throw new Error(`Auth failed with status ${response.status}`);
  }

  const data = await response.json();

  tokenCache.accessToken = data.access_token;
  tokenCache.expiresAt = now + data.expires_in * 1000;

  return tokenCache.accessToken;
}

function parseSimcQuery(query) {
  const {
    raid,
    boss,
    difficulty = 'mythic',
    period,
    pullId,
    format,
  } = query;

  if (!raid || !boss) {
    return {
      error: 'Missing required query params: raid, boss',
    };
  }

  const parsedPeriod = period !== undefined ? Number(period) : undefined;
  if (period !== undefined && Number.isNaN(parsedPeriod)) {
    return {
      error: 'Invalid period query param',
    };
  }

  return {
    raid,
    boss,
    difficulty,
    period: parsedPeriod,
    pullId: pullId ? Number(pullId) : undefined,
    format,
  };
}

async function resolvePullContext(guildConfig, query) {
  const params = parseSimcQuery(query);
  if (params.error) {
    return { error: params.error, status: 400 };
  }

  let pullId = params.pullId;
  let period = params.period;
  let pullsData = null;

  if (pullId) {
    return {
      params,
      pullId,
      period,
    };
  }

  if (period !== undefined) {
    pullsData = await getBossPulls({
      raid: params.raid,
      boss: params.boss,
      difficulty: params.difficulty,
      region: guildConfig.region,
      realm: guildConfig.realm,
      guild: guildConfig.name,
      period,
    });

    pullId = getLatestPullId(pullsData);
    if (!pullId) {
      return {
        error: 'No pulls found for the given raid, boss, and period',
        status: 404,
        meta: {
          raid: params.raid,
          boss: params.boss,
          difficulty: params.difficulty,
          period,
        },
      };
    }

    return {
      params,
      pullId,
      period,
      pullsData,
    };
  }

  const latest = await findLatestPull({
    raid: params.raid,
    boss: params.boss,
    difficulty: params.difficulty,
    region: guildConfig.region,
    realm: guildConfig.realm,
    guild: guildConfig.name,
  });

  if (!latest) {
    return {
      error: 'No pulls found. Provide period or pullId, or try a different boss/raid.',
      status: 404,
      meta: {
        raid: params.raid,
        boss: params.boss,
        difficulty: params.difficulty,
      },
    };
  }

  return {
    params,
    pullId: latest.pullId,
    period: latest.period,
    pullsData: latest.pullsData,
  };
}

// Route: GET /api/guilds
app.get('/api/guilds', (_req, res) => {
  return res.json({ guilds: listGuilds() });
});

// Route: GET /api/simc/:guild/pulls?raid=&boss=&difficulty=mythic&period=
app.get('/api/simc/:guild/pulls', async (req, res) => {
  try {
    const guildConfig = getGuild(req.params.guild);
    const params = parseSimcQuery(req.query);

    if (params.error) {
      return res.status(400).json({ error: params.error });
    }

    if (params.period === undefined) {
      return res.status(400).json({
        error: 'Missing required query param: period',
      });
    }

    const pullsData = await getBossPulls({
      raid: params.raid,
      boss: params.boss,
      difficulty: params.difficulty,
      region: guildConfig.region,
      realm: guildConfig.realm,
      guild: guildConfig.name,
      period: params.period,
    });

    return res.json({
      guild: guildConfig.key,
      raid: params.raid,
      boss: params.boss,
      difficulty: params.difficulty,
      period: params.period,
      count: pullsData.count ?? pullsData.pulls?.length ?? 0,
      latestPullId: getLatestPullId(pullsData),
      pulls: pullsData.pulls ?? [],
    });
  } catch (error) {
    console.error('Pull lookup error:', error.message);
    return res.status(error.status || 500).json({
      error: error.message || 'Internal server error',
    });
  }
});

// Route: GET /api/simc/:guild?raid=&boss=&difficulty=mythic&period=|pullId=
app.get('/api/simc/:guild', async (req, res) => {
  try {
    const guildConfig = getGuild(req.params.guild);
    const pullContext = await resolvePullContext(guildConfig, req.query);

    if (pullContext.error) {
      return res.status(pullContext.status).json({
        error: pullContext.error,
        meta: pullContext.meta,
      });
    }

    const { params, pullId, period } = pullContext;

    const compData = await getRaidComp({
      raid: params.raid,
      boss: params.boss,
      difficulty: params.difficulty,
      region: guildConfig.region,
      realm: guildConfig.realm,
      guild: guildConfig.name,
      guildId: guildConfig.guildId,
      pullId,
    });

    const roster = compData?.details?.roster ?? [];
    const exports = rosterToSimcExports(roster);

    if (params.format === 'raw') {
      res.type('text/plain');
      return res.send(exports.map((entry) => entry.simc).join('\n\n'));
    }

    return res.json({
      guild: guildConfig.key,
      pullId,
      period,
      raid: params.raid,
      boss: params.boss,
      difficulty: params.difficulty,
      rosterSize: exports.length,
      exports,
    });
  } catch (error) {
    console.error('SimC export error:', error.message);
    return res.status(error.status || 500).json({
      error: error.message || 'Internal server error',
    });
  }
});

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
      headers: { Authorization: `Bearer ${accessToken}` },
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
