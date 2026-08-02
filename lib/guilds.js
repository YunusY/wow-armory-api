// The background worker enumerates each guild's full boss list itself every
// cycle (via raider.io's world raid-rankings, see
// simcEngine.getRaidRankings) — no boss is configured here.
const TRACKED_GUILDS = {
  echo: {
    guildId: '1047044',
    region: 'eu',
    realm: 'tarren-mill',
    raid: 'tier-mn-1',
    difficulty: 'mythic',
  },
  liquid: {
    guildId: '1712677',
    region: 'us',
    realm: 'illidan',
    raid: 'tier-mn-1',
    difficulty: 'mythic',
  },
  method: {
    guildId: '316123',
    region: 'eu',
    realm: 'twisting-nether',
    raid: 'tier-mn-1',
    difficulty: 'mythic',
  },
};

function getGuild(key) {
  if (!key) return null;
  const guild = TRACKED_GUILDS[key.toLowerCase()];
  return guild ? { key: key.toLowerCase(), ...guild } : null;
}

function listGuilds() {
  return Object.entries(TRACKED_GUILDS).map(([key, guild]) => ({ key, ...guild }));
}

module.exports = { TRACKED_GUILDS, getGuild, listGuilds };
