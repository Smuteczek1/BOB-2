const { SlashCommandBuilder, PermissionFlagsBits, AttachmentBuilder, MessageFlags } = require('discord.js');
const db = require('../db');
const { levelForXp } = require('../utils/leveling');

// Pole CSV: w cudzysłowie, z podwojonymi cudzysłowami w środku (bezpieczne dla nicków z przecinkami)
function csvField(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

// Buduje CSV z BOM-em, żeby Excel poprawnie pokazał polskie znaki
function buildCsv(rows) {
  const header = ['user_id', 'nick', 'xp', 'poziom_zapisany', 'poziom_z_xp'].join(',');
  const lines = rows.map((r) => [
    csvField(r.user_id),
    csvField(r.nick),
    r.xp,
    r.level,
    r.levelFromXp,
  ].join(','));
  return '\uFEFF' + [header, ...lines].join('\n');
}

module.exports = {
  buildCsv,
  data: new SlashCommandBuilder()
    .setName('eksport-poziomow')
    .setDescription('Wysyła plik CSV z XP i poziomami wszystkich osób (kopia zapasowa). Tylko administracja.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guild = interaction.guild;
    const levels = await db.getAllUserLevels(guild.id);
    if (levels.length === 0) {
      await interaction.editReply({ content: 'Brak danych o poziomach na tym serwerze.' });
      return;
    }

    // Nicki tylko dla czytelności pliku; jeśli się nie uda ich pobrać, zostają same ID
    const members = await guild.members.fetch().catch(() => null);

    const rows = levels.map((r) => {
      const member = members?.get(r.user_id);
      return {
        user_id: r.user_id,
        nick: member ? member.displayName : '(nie ma na serwerze)',
        xp: r.xp,
        level: r.level,
        levelFromXp: levelForXp(r.xp),
      };
    });

    const file = new AttachmentBuilder(Buffer.from(buildCsv(rows), 'utf-8'), { name: 'poziomy.csv' });
    await interaction.editReply({
      content: `📄 Eksport poziomów: **${rows.length}** osób. Plik widzisz tylko Ty. Zawiera ID i nicki członków, więc nie wrzucaj go publicznie.`,
      files: [file],
    });
  },
};
