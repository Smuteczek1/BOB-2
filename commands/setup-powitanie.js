const { SlashCommandBuilder, ChannelType, PermissionFlagsBits, MessageFlags } = require('discord.js');
const db = require('../db');
const { buildWelcomeEmbed } = require('../utils/onboarding');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup-powitanie')
    .setDescription('Konfiguruje system powitań nowych użytkowników.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub
      .setName('ustaw')
      .setDescription('Ustawia kanał i (opcjonalnie) własną treść powitania.')
      .addChannelOption(opt => opt
        .setName('kanal')
        .setDescription('Kanał, na który bot będzie wysyłać powitania')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true))
      .addStringOption(opt => opt
        .setName('wiadomosc')
        .setDescription('Własna treść (zmienne: {user} {username} {server} {membercount}). Puste = domyślna.')
        .setRequired(false)))
    .addSubcommand(sub => sub
      .setName('wylacz')
      .setDescription('Wyłącza wysyłanie powitań.'))
    .addSubcommand(sub => sub
      .setName('podglad')
      .setDescription('Pokazuje podgląd aktualnego powitania.')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    if (sub === 'ustaw') {
      const channel = interaction.options.getChannel('kanal');
      const message = interaction.options.getString('wiadomosc');

      await db.setWelcomeConfig(guildId, { channelId: channel.id, message });

      await interaction.reply({
        content:
          `✅ Powitania będą wysyłane na <#${channel.id}>` +
          (message ? ' z Twoją własną treścią.' : ' z domyślną treścią.') +
          `\n\nDostępne zmienne: \`{user}\` (wzmianka), \`{username}\`, \`{server}\`, \`{membercount}\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'wylacz') {
      await db.setWelcomeConfig(guildId, { channelId: null, message: undefined });
      await interaction.reply({
        content: '✅ Wyłączono system powitań.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'podglad') {
      const config = await db.getGuildConfig(guildId);
      const embed = buildWelcomeEmbed(interaction.member, config?.welcome_message);

      await interaction.reply({
        content: config?.welcome_channel_id
          ? `Podgląd — aktualnie wysyłane na <#${config.welcome_channel_id}>:`
          : '⚠️ Powitania są obecnie wyłączone. Oto podgląd zapisanej/domyślnej treści:',
        embeds: [embed],
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
