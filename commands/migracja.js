const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  MessageFlags,
} = require('discord.js');
const fs = require('node:fs');
const db = require('../db');
const { syncLevelRole } = require('../utils/levelRoles');
const { MIGRATION_ID, MIGRATION_FILE, loadMigration } = require('../utils/migracja');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('migracja')
    .setDescription('Jednorazowy reset poziomów według pliku data/migracja.csv. Tylko administracja.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub.setName('podglad').setDescription('Pokazuje, co zostanie zmienione. Niczego nie zmienia.'))
    .addSubcommand((sub) =>
      sub.setName('zastosuj')
        .setDescription('Stosuje migrację (po potwierdzeniu przyciskiem).')
        .addRoleOption((opt) =>
          opt.setName('rola').setDescription('Rola "Byłem tu" nadawana osobom z odznaką w pliku').setRequired(true))
        .addBooleanOption((opt) =>
          opt.setName('reset_monet').setDescription('Wyzeruj też salda monet i historię (domyślnie: nie)'))
        .addBooleanOption((opt) =>
          opt.setName('wymus').setDescription('Pozwól uruchomić ponownie. UWAGA: nadpisze postępy zdobyte po pierwszym razie!'))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'podglad') return handlePreview(interaction);
    if (sub === 'zastosuj') return handleApply(interaction);
  },
};

function summarize(rows) {
  const withBadge = rows.filter((r) => r.badge);
  return {
    total: rows.length,
    badge: withBadge.length,
    maxNew: Math.max(...rows.map((r) => r.newLevel)),
    maxOld: Math.max(...rows.map((r) => r.oldLevel)),
  };
}

async function handlePreview(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let rows;
  try {
    rows = loadMigration();
  } catch (err) {
    await interaction.editReply({ content: `❌ Nie mogę wczytać pliku migracji: ${err.message}` });
    return;
  }

  const s = summarize(rows);
  const members = await interaction.guild.members.fetch().catch(() => null);
  const present = members ? rows.filter((r) => members.has(r.userId)).length : null;

  const embed = new EmbedBuilder()
    .setTitle('🔍 Podgląd migracji poziomów')
    .setColor(0x3498db)
    .setDescription(
      'To jest **tylko podgląd**, nic nie zostało zmienione. Poniżej plik, który bot zastosuje. ' +
      'Możesz go otworzyć w Excelu, poprawić ręcznie i wgrać do `data/migracja.csv`.',
    )
    .addFields(
      { name: 'Osób w pliku', value: String(s.total), inline: true },
      { name: 'Z tego na serwerze', value: present === null ? '?' : String(present), inline: true },
      { name: 'Dostaną rolę "Byłem tu"', value: String(s.badge), inline: true },
      { name: 'Najwyższy poziom', value: `${s.maxOld} → ${s.maxNew}`, inline: true },
    );

  const file = new AttachmentBuilder(fs.readFileSync(MIGRATION_FILE), { name: 'migracja.csv' });
  await interaction.editReply({ embeds: [embed], files: [file] });
}

async function handleApply(interaction) {
  const role = interaction.options.getRole('rola');
  const resetCoins = interaction.options.getBoolean('reset_monet') ?? false;
  const force = interaction.options.getBoolean('wymus') ?? false;

  let rows;
  try {
    rows = loadMigration();
  } catch (err) {
    await interaction.reply({ content: `❌ Nie mogę wczytać pliku migracji: ${err.message}`, flags: MessageFlags.Ephemeral });
    return;
  }

  // Sprawdzamy rolę ZANIM cokolwiek zmienimy w bazie
  const botMember = interaction.guild.members.me;
  if (role.managed || role.position >= botMember.roles.highest.position) {
    await interaction.reply({
      content:
        `⚠️ Rola **${role.name}** jest wyżej niż najwyższa rola bota (albo jest rolą systemową), więc bot nie mógłby jej nadawać. ` +
        'Przesuń rolę bota wyżej w Ustawieniach serwera → Role i spróbuj ponownie. Nic nie zostało zmienione.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const s = summarize(rows);
  const confirmEmbed = new EmbedBuilder()
    .setTitle('⚠️ Potwierdź migrację poziomów')
    .setColor(0xe67e22)
    .setDescription(
      `Zostanie ustawione XP i poziom dla **${s.total}** osób według pliku (najwyższy poziom: ${s.maxOld} → ${s.maxNew}).\n` +
      `Rolę ${role} dostanie **${s.badge}** osób (te, które są na serwerze).\n` +
      `Monety: **${resetCoins ? 'ZOSTANĄ wyzerowane' : 'bez zmian'}**.\n\n` +
      'To nadpisuje obecne XP tych osób. Upewnij się, że masz kopię z `/eksport-poziomow`. Na decyzję masz 60 sekund.',
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('migracja_ok').setLabel('Zatwierdź').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('migracja_cancel').setLabel('Anuluj').setStyle(ButtonStyle.Secondary),
  );

  await interaction.reply({ embeds: [confirmEmbed], components: [row], flags: MessageFlags.Ephemeral });
  const message = await interaction.fetchReply();

  let click;
  try {
    click = await message.awaitMessageComponent({
      filter: (i) => i.user.id === interaction.user.id,
      time: 60_000,
    });
  } catch {
    await interaction.editReply({ content: '⌛ Czas minął, nic nie zostało zmienione.', embeds: [], components: [] });
    return;
  }

  if (click.customId === 'migracja_cancel') {
    await click.update({ content: '❎ Anulowano. Nic nie zostało zmienione.', embeds: [], components: [] });
    return;
  }

  await click.update({ content: '⏳ Stosuję migrację...', embeds: [], components: [] });

  const guild = interaction.guild;
  console.log(`[migracja] ${interaction.user.tag} (${interaction.user.id}) uruchomił migrację na ${guild.id} (reset_monet=${resetCoins}, wymus=${force})`);

  let result;
  try {
    result = await db.applyLevelMigration(
      guild.id,
      MIGRATION_ID,
      rows.map((r) => ({ userId: r.userId, xp: r.newXp, level: r.newLevel })),
      { resetCoins, force },
    );
  } catch (err) {
    console.error('[migracja] błąd bazy:', err);
    await interaction.editReply({ content: '❌ Błąd bazy danych. Transakcja została cofnięta, **nic nie zostało zmienione**.' });
    return;
  }

  if (result.alreadyApplied) {
    await interaction.editReply({
      content:
        '🛑 Ta migracja była już wykonana na tym serwerze, więc nic nie zmieniłem (żeby nie skasować postępów zdobytych po niej). ' +
        'Jeśli naprawdę chcesz ją powtórzyć, użyj opcji `wymus`.',
    });
    return;
  }

  // Role: dopiero po udanym zapisie w bazie
  const members = await guild.members.fetch().catch(() => null);
  let rolesSynced = 0;
  let badgesGiven = 0;
  let absent = 0;
  let errors = 0;

  for (const r of rows) {
    const member = members?.get(r.userId);
    if (!member) { absent++; continue; }
    try {
      await syncLevelRole(interaction.client, guild.id, r.userId, r.newLevel);
      rolesSynced++;
      if (r.badge && !member.roles.cache.has(role.id)) {
        await member.roles.add(role.id, 'Migracja poziomów: Byłem tu');
        badgesGiven++;
      }
    } catch (err) {
      errors++;
      console.error(`[migracja] błąd ról dla ${r.userId}:`, err);
    }
  }

  await interaction.editReply({
    content:
      `✅ **Migracja zakończona.**\n` +
      `• XP i poziomy ustawione: **${result.updated}** osób\n` +
      `• Role za poziom zsynchronizowane: **${rolesSynced}**\n` +
      `• Nadano ${role}: **${badgesGiven}**\n` +
      `• Poza serwerem (mają zapisane XP, ale bez ról): **${absent}**\n` +
      (errors > 0 ? `• ⚠️ Błędy przy rolach: **${errors}** (sprawdź hierarchię ról bota i logi)\n` : '') +
      (resetCoins ? '• Monety zostały wyzerowane.\n' : ''),
  });
}
