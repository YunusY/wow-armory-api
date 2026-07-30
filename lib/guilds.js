const TRACKED_GUILDS = {
  echo: {
    guildId: '1047044',
    region: 'eu',
    realm: 'tarren-mill',
    raid: 'tier-mn-1',
    boss: 'midnight-falls',
    difficulty: 'mythic',
  },
  liquid: {
    guildId: '1712677',
    region: 'us',
    realm: 'illidan',
    raid: 'tier-mn-1',
    boss: 'midnight-falls',
    difficulty: 'mythic',
  },
  method: {
    guildId: '316123',
    region: 'eu',
    realm: 'tarren-mill',
    raid: 'tier-mn-1',
    boss: 'midnight-falls',
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
