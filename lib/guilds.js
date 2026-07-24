const GUILDS = {
  liquid: {
    name: 'Liquid',
    region: 'us',
    realm: 'illidan',
    guildId: 1712677,
  },
  echo: {
    name: 'Echo',
    region: 'eu',
    realm: 'tarren-mill',
    guildId: 1047044,
  },
};

function getGuild(key) {
  const guild = GUILDS[key.toLowerCase()];
  if (!guild) {
    const supported = Object.keys(GUILDS).join(', ');
    throw new Error(`Unknown guild "${key}". Supported guilds: ${supported}`);
  }
  return { key: key.toLowerCase(), ...guild };
}

function listGuilds() {
  return Object.entries(GUILDS).map(([key, guild]) => ({
    key,
    name: guild.name,
    region: guild.region,
    realm: guild.realm,
  }));
}

module.exports = { getGuild, listGuilds, GUILDS };
