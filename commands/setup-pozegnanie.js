const { SlashCommandBuilder, ChannelType, PermissionFlagsBits, MessageFlags } = require('discord.js');
const db = require('../db');
const { buildGoodbyeEmbed } = require('../utils/onboarding');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup-pozegnanie')
    .setDescription('Konfiguruje system pożegnań odchodzących użytkowników.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub
      .setName('ustaw')
      .setDescription('Ustawia kanał i (opcjonalnie) własną treść pożegnania.')
      .addChannelOption(opt => opt
        .setName('kanal')
        .setDescription('Kanał, na który bot będzie wysyłać pożegnania')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true))
      .addStringOption(opt => opt
        .setName('wiadomosc')
        .setDescription('Własna treść (zmienne: {username} {tag} {server} {membercount}). Puste = domyślna.')
        .setRequired(false)))
    .addSubcommand(sub => sub
      .setName('wylacz')
      .setDescription('Wyłącza wysyłanie pożegnań.'))
    .addSubcommand(sub => sub
      .setName('podglad')
      .setDescription('Pokazuje podgląd aktualnego pożegnania.')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    if (sub === 'ustaw') {
      const channel = interaction.options.getChannel('kanal');
      const message = interaction.options.getString('wiadomosc');

      await db.setGoodbyeConfig(guildId, { channelId: channel.id, message });

      await interaction.reply({
        content:
          `✅ Pożegnania będą wysyłane na <#${channel.id}>` +
          (message ? ' z Twoją własną treścią.' : ' z domyślną treścią.') +
          `\n\nDostępne zmienne: \`{username}\`, \`{tag}\`, \`{server}\`, \`{membercount}\`. ` +
          `(Uwaga: \`{user}\` — wzmianka — nie zadziała w pożegnaniu, bo osoba już opuściła serwer.)`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'wylacz') {
      await db.setGoodbyeConfig(guildId, { channelId: null, message: undefined });
      await interaction.reply({
        content: '✅ Wyłączono system pożegnań.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'podglad') {
      const config = await db.getGuildConfig(guildId);
      const embed = buildGoodbyeEmbed(interaction.member, config?.goodbye_message);

      await interaction.reply({
        content: config?.goodbye_channel_id
          ? `Podgląd — aktualnie wysyłane na <#${config.goodbye_channel_id}>:`
          : '⚠️ Pożegnania są obecnie wyłączone. Oto podgląd zapisanej/domyślnej treści:',
        embeds: [embed],
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
