const RAIDER_IO_BASE = 'https://raider.io/api/v1';

function buildUrl(path, params) {
  const url = new URL(`${RAIDER_IO_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function fetchJson(url) {
  const response = await fetch(url);
  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const message = data?.message || `Raider.IO request failed with status ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.url = url;
    throw error;
  }

  return data;
}

async function getBossPulls({ raid, boss, difficulty, region, realm, guild, period }) {
  const url = buildUrl('/live-tracking/guild/boss-pulls', {
    raid,
    boss,
    difficulty,
    region,
    realm,
    guild,
    period,
  });

  return fetchJson(url);
}

async function getRaidComp({ raid, boss, difficulty, region, realm, guild, guildId, pullId }) {
  const url = buildUrl('/live-tracking/guild/raid-comps', {
    raid,
    difficulty,
    id: pullId,
    guild_id: guildId,
    region,
    realm,
    boss,
    guild,
  });

  return fetchJson(url);
}

function getLatestPullId(pullsData) {
  const pulls = pullsData?.pulls;
  if (!Array.isArray(pulls) || pulls.length === 0) {
    return null;
  }

  const latestPull = pulls[pulls.length - 1];
  return latestPull?.details?.id ?? null;
}

async function findLatestPull({ raid, boss, difficulty, region, realm, guild, maxPeriod = 50 }) {
  for (let period = maxPeriod; period >= 1; period -= 1) {
    const pullsData = await getBossPulls({
      raid,
      boss,
      difficulty,
      region,
      realm,
      guild,
      period,
    });

    const pullId = getLatestPullId(pullsData);
    if (pullId) {
      return { pullId, period, pullsData };
    }
  }

  return null;
}

module.exports = {
  getBossPulls,
  getRaidComp,
  getLatestPullId,
  findLatestPull,
};
