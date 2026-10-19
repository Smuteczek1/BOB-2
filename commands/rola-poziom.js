const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');
const db = require('../db');
const { syncLevelRole, buildLevelRolesListPayload } = require('../utils/levelRoles');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rola-poziom')
    .setDescription('Zarządzanie rolami przyznawanymi automatycznie za osiągnięcie poziomu.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand(sub =>
      sub.setName('ustaw')
        .setDescription('Przypisuje rolę do danego poziomu (0 = rola od razu po dołączeniu do serwera).')
        .addIntegerOption(opt =>
          opt.setName('poziom')
            .setDescription('Od jakiego poziomu obowiązuje ta rola (0 = od dołączenia)')
            .setRequired(true)
            .setMinValue(0))
        .addRoleOption(opt =>
          opt.setName('rola')
            .setDescription('Rola do przyznania od tego poziomu')
            .setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('usun')
        .setDescription('Usuwa przypisanie roli dla danego poziomu (nie usuwa samej roli z serwera).')
        .addIntegerOption(opt =>
          opt.setName('poziom')
            .setDescription('Poziom do usunięcia z drabinki')
            .setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('lista')
        .setDescription('Pokazuje całą drabinkę ról za poziomy.'))
    .addSubcommand(sub =>
      sub.setName('sync')
        .setDescription('Nadaje/aktualizuje role za poziom WSZYSTKIM obecnym członkom serwera (jednorazowo).')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'ustaw') return handleSet(interaction);
    if (sub === 'usun') return handleRemove(interaction);
    if (sub === 'lista') return handleList(interaction);
    if (sub === 'sync') return handleSync(interaction);
  },
};

async function handleSet(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const level = interaction.options.getInteger('poziom');
  const role = interaction.options.getRole('rola');

  const botMember = interaction.guild.members.me;
  if (role.position >= botMember.roles.highest.position) {
    await interaction.editReply({
      content:
        `⚠️ Rola **${role.name}** jest wyżej (lub tak samo wysoko) niż najwyższa rola bota, więc bot nie będzie ` +
        `mógł jej nadawać. Przesuń rolę bota wyżej w Ustawieniach serwera -> Role i spróbuj ponownie.`,
    });
    return;
  }

  await db.setLevelRole(interaction.guild.id, level, role.id);

  await interaction.editReply({
    content: `✅ Od poziomu **${level}** użytkownicy będą automatycznie dostawać rolę **${role.name}** (i tracić poprzednią z tej drabinki).`,
  });
}

async function handleRemove(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const level = interaction.options.getInteger('poziom');
  await db.removeLevelRole(interaction.guild.id, level);

  await interaction.editReply({ content: `✅ Usunięto przypisanie roli dla poziomu **${level}** z drabinki.` });
}

async function handleList(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const tiers = await db.getLevelRoles(interaction.guild.id);

  // Bezpiecznik: Jeśli brak ról w bazie – wyślij czytelny komunikat zamiast pustego błędu
  if (!tiers || tiers.length === 0) {
    await interaction.editReply({
      content: '📋 Na tym serwerze nie skonfigurowano jeszcze żadnych ról za poziomy. Użyj `/rola-poziom ustaw`, aby dodać pierwszą.',
    });
    return;
  }

  // Formatowanie listy ról
  // Kolumna w bazie nazywa się "level" (wcześniej kod czytał nieistniejące "required_level")
  const getLvl = r => r.level ?? r.required_level ?? 0;
  const sorted = [...tiers].sort((a, b) => getLvl(a) - getLvl(b));
  const listText = sorted
    .map(r => `• **Poziom ${getLvl(r)}:** <@&${r.role_id}>`)
    .join('\n');

  const embed = new EmbedBuilder()
    .setTitle('🏆 Drabinka ról za poziomy')
    .setColor(0x3498db)
    .setDescription(listText)
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleSync(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const tiers = await db.getLevelRoles(interaction.guild.id);
  if (!tiers || tiers.length === 0) {
    await interaction.editReply({ content: '⚠️ Nie masz jeszcze skonfigurowanej drabinki ról - użyj najpierw `/rola-poziom ustaw`.' });
    return;
  }

  const members = await interaction.guild.members.fetch().catch(() => null);
  if (!members) {
    await interaction.editReply({ content: '❌ Nie udało się pobrać listy członków serwera.' });
    return;
  }

  let updated = 0;
  let errors = 0;

  for (const member of members.values()) {
    if (member.user.bot) continue;
    try {
      const existing = await db.getUserLevel(interaction.guild.id, member.id);
      const level = existing ? existing.level : 0;
      await syncLevelRole(interaction.client, interaction.guild.id, member.id, level);
      updated++;
    } catch {
      errors++;
    }
  }

  await interaction.editReply({
    content:
      `✅ Zsynchronizowano role dla **${updated}** osób` +
      (errors > 0 ? ` (nie udało się dla ${errors} - sprawdź hierarchię ról bota)` : '') +
      `.\n\n💡 Wskazówka: przy dużym serwerze to mogło chwilę potrwać - Discord ogranicza tempo zmian ról.`,
  });
}
