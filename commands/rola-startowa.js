const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const db = require('../db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rola-startowa')
    .setDescription('Konfiguruje rolę automatycznie nadawaną nowym użytkownikom.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand(sub => sub
      .setName('ustaw')
      .setDescription('Ustawia rolę startową.')
      .addRoleOption(opt => opt
        .setName('rola')
        .setDescription('Rola nadawana każdemu nowemu członkowi')
        .setRequired(true))
      .addBooleanOption(opt => opt
        .setName('zastepowana_przy_weryfikacji')
        .setDescription('Czy ta rola ma być zdejmowana po zaakceptowaniu regulaminu (weryfikacji)?')
        .setRequired(true)))
    .addSubcommand(sub => sub
      .setName('wylacz')
      .setDescription('Wyłącza automatyczne nadawanie roli startowej.'))
    .addSubcommand(sub => sub
      .setName('podglad')
      .setDescription('Pokazuje obecną konfigurację roli startowej.')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    if (sub === 'ustaw') {
      const role = interaction.options.getRole('rola');
      const replaceOnVerify = interaction.options.getBoolean('zastepowana_przy_weryfikacji');

      if (role.managed) {
        await interaction.reply({
          content: '❌ Nie można ustawić jako startowej roli zarządzanej przez integrację/bota.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const botMember = interaction.guild.members.me;
      if (botMember && role.position >= botMember.roles.highest.position) {
        await interaction.reply({
          content:
            '⚠️ Ta rola jest wyżej (lub na równi) w hierarchii niż najwyższa rola bota — ' +
            'bot **nie będzie w stanie** jej nadawać. Przesuń rolę bota wyżej na liście ról serwera.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await db.setStarterRoleConfig(guildId, { roleId: role.id, replaceOnVerify });

      await interaction.reply({
        content:
          `✅ Rola startowa ustawiona na <@&${role.id}>.\n` +
          (replaceOnVerify
            ? '🔁 Zostanie automatycznie zdjęta po zaakceptowaniu regulaminu (weryfikacji).'
            : '📌 Pozostanie na użytkowniku nawet po weryfikacji.'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'wylacz') {
      await db.setStarterRoleConfig(guildId, { roleId: null, replaceOnVerify: undefined });
      await interaction.reply({
        content: '✅ Wyłączono automatyczne nadawanie roli startowej.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'podglad') {
      const config = await db.getGuildConfig(guildId);
      if (!config || !config.starter_role_id) {
        await interaction.reply({
          content: 'ℹ️ Rola startowa nie jest obecnie skonfigurowana.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.reply({
        content:
          `📌 Obecna rola startowa: <@&${config.starter_role_id}>\n` +
          `🔁 Zastępowana przy weryfikacji: **${config.starter_role_replace_on_verify ? 'Tak' : 'Nie'}**`,
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
