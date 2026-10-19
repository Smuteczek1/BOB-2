const {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require('discord.js');
const db = require('../db');

const LEVEL_ROLE_SELECT_CUSTOM_ID = 'level_role_remove_select';

async function syncLevelRole(client, guildId, userId, level) {
  const tiers = await db.getLevelRoles(guildId);
  if (!tiers || tiers.length === 0) return;

  // Pobieramy poziom niezależnie od nazwy kolumny w bazie (level / required_level)
  const getLvl = t => t.level ?? t.required_level ?? 0;

  // Sortujemy malejąco, aby znaleźć najwyższą osiągniętą rolę
  const sortedDesc = [...tiers].sort((a, b) => getLvl(b) - getLvl(a));
  const applicable = sortedDesc.find(t => getLvl(t) <= level);
  if (!applicable) return;

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;

  const allTierRoleIds = new Set(tiers.map(t => t.role_id));
  const toRemove = member.roles.cache.filter(r => allTierRoleIds.has(r.id) && r.id !== applicable.role_id);

  try {
    if (toRemove.size > 0) {
      await member.roles.remove([...toRemove.keys()]);
    }
    if (!member.roles.cache.has(applicable.role_id)) {
      await member.roles.add(applicable.role_id);
    }
  } catch (err) {
    console.error('Błąd podczas synchronizacji roli za poziom (sprawdź hierarchię ról bota):', err);
  }
}

async function buildLevelRolesListPayload(guild) {
  const tiers = await db.getLevelRoles(guild.id);
  if (!tiers || tiers.length === 0) {
    return {
      content: '⚠️ Nie masz jeszcze skonfigurowanej drabinki ról - użyj najpierw `/rola-poziom ustaw`.',
      components: [],
    };
  }

  const getLvl = t => t.level ?? t.required_level ?? 0;
  const sortedAsc = [...tiers].sort((a, b) => getLvl(a) - getLvl(b));

  const embed = new EmbedBuilder()
    .setTitle('🏅 Drabinka ról za poziomy')
    .setColor(0x5865f2)
    .setDescription(sortedAsc.map(t => `**Poziom ${getLvl(t)}** — <@&${t.role_id}>`).join('\n'))
    .setFooter({ text: 'Wybierz pozycję z listy poniżej, żeby usunąć ją z drabinki.' });

  const options = sortedAsc.slice(0, 25).map(t => {
    const lvl = getLvl(t);
    const role = guild.roles.cache.get(t.role_id);
    return new StringSelectMenuOptionBuilder()
      .setLabel(`Poziom ${lvl}${role ? ` — ${role.name}` : ''}`.slice(0, 100))
      .setValue(String(lvl));
  });

  const select = new StringSelectMenuBuilder()
    .setCustomId(LEVEL_ROLE_SELECT_CUSTOM_ID)
    .setPlaceholder('Wybierz rolę do usunięcia z drabinki...')
    .addOptions(options);

  const row = new ActionRowBuilder().addComponents(select);

  return { embeds: [embed], components: [row] };
}

async function handleLevelRoleSelectMenu(interaction) {
  const level = parseInt(interaction.values[0], 10);
  const tiers = await db.getLevelRoles(interaction.guild.id);
  
  const getLvl = t => t.level ?? t.required_level ?? 0;
  const tier = tiers ? tiers.find(t => getLvl(t) === level) : null;

  await db.removeLevelRole(interaction.guild.id, level);

  await interaction.update({
    content: tier
      ? `✅ Usunięto przypisanie roli <@&${tier.role_id}> dla poziomu **${level}** z drabinki.`
      : `✅ Usunięto przypisanie dla poziomu **${level}**.`,
    embeds: [],
    components: [],
  });
}

module.exports = {
  syncLevelRole,
  buildLevelRolesListPayload,
  LEVEL_ROLE_SELECT_CUSTOM_ID,
  handleLevelRoleSelectMenu,
};
