// Temporary workaround for missing crafted-stat bonus IDs on certain BoE items.
// Armory lookups will replace this once the fallback pipeline is wired up.
const BOE_ITEMS = new Set([
  'primal_spark_pauldrons',
  'power_stance_breeches',
  'visage_of_unseen_truths',
  'infernal_greatlock_girdle',
  'nullstriders_boots',
  'raging_storm_sash',
  'fading_dawn_sabatons',
  'breastplate_of_the_final_defense',
]);

const STAT_BONUS_IDS = {
  'crit haste': '32:36',
  'crit mastery': '32:49',
  'crit versa': '32:40',
  'haste crit': '36:32',
  'haste mastery': '36:49',
  'haster versa': '36:40',
  'mastery crit': '49:32',
  'mastery haste': '49:36',
  'mastery versa': '49:40',
  'versa crit': '40:32',
  'versa haste': '40:36',
  'versa mastery': '40:49',
};

const SPEC_STAT_CHOICES = {
  'mage-frost': 'crit mastery',
  'paladin-retribution': 'crit mastery',
  'warrior-protection': 'crit haste',
  'druid-guardian': 'haste mastery',
  'deathknight-unholy': 'crit mastery',
  'hunter-marksmanship': 'crit mastery',
  'priest-shadow': 'mastery haste',
  'rogue-subtlety': 'crit mastery',
  'shaman-elemental': 'crit mastery',
  'warlock-demonology': 'crit haste',
  'monk-windwalker': 'haste crit',
  'evoker-augmentation': 'crit haste',
  'demonhunter-devourer': 'haste mastery',
};

const GEAR_SLOTS = [
  'head',
  'neck',
  'shoulder',
  'back',
  'chest',
  'waist',
  'wrist',
  'hands',
  'legs',
  'feet',
  'finger1',
  'finger2',
  'trinket1',
  'trinket2',
  'mainhand',
  'offhand',
];

function slugToSimcToken(value) {
  return value.replace(/-/g, '_');
}

function itemNameToSimcToken(name) {
  return name.replace(/'/g, '').replace(/ /g, '_');
}

function getClassSpecKey(character) {
  const classSlug = character.class.slug.replace(/-/g, '');
  const specSlug = character.spec.name.toLowerCase().replace(/-/g, '_');
  return `${classSlug}-${specSlug}`;
}

function appendGearLine(lines, slot, item, character) {
  const itemName = itemNameToSimcToken(item.name);
  const slotKey = slot === 'mainhand' ? 'main_hand' : slot === 'offhand' ? 'off_hand' : slot;

  let line = `${slotKey}=${itemName},id=${item.item_id}`;

  if (item.enchant) {
    line += `,enchant_id=${item.enchant}`;
  }

  if (item.gems?.length) {
    line += `,gem_id=${item.gems.join('/')}`;
  }

  if (item.bonuses?.length) {
    line += `,bonus_id=${item.bonuses.join('/')}`;
  }

  const normalizedItemName = itemName.toLowerCase();
  if (BOE_ITEMS.has(normalizedItemName)) {
    const classSpec = getClassSpecKey(character);
    const statChoice = SPEC_STAT_CHOICES[classSpec];
    const missingStat = statChoice ? STAT_BONUS_IDS[statChoice] : null;
    if (missingStat) {
      line += `/${missingStat}`;
    }
  }

  lines.push(line);
}

function characterToSimc(character) {
  const lines = [];

  lines.push(`${character.class.slug.replace(/-/g, '')}=${character.name}`);
  lines.push('level=90');
  lines.push(`race=${slugToSimcToken(character.race.slug)}`);
  lines.push(`spec=${character.spec.name.toLowerCase().replace(/-/g, '_')}`);

  if (character.talentLoadout?.loadoutText) {
    lines.push(`talents=${character.talentLoadout.loadoutText}`);
  }

  const items = character.items?.items ?? {};
  for (const slot of GEAR_SLOTS) {
    const item = items[slot];
    if (item) {
      appendGearLine(lines, slot, item, character);
    }
  }

  return lines.join('\n');
}

function rosterToSimcExports(roster) {
  if (!Array.isArray(roster)) {
    return [];
  }

  return roster
    .filter((entry) => entry?.character)
    .map((entry) => {
      const character = entry.character;
      return {
        name: character.name,
        class: character.class?.name ?? null,
        spec: character.spec?.name ?? null,
        role: entry.role ?? null,
        simc: characterToSimc(character),
      };
    });
}

module.exports = {
  characterToSimc,
  rosterToSimcExports,
};
