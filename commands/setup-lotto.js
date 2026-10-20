const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const lotto = require('../utils/lotto');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup-lotto')
    .setDescription('Ustawia kanał, na którym Bob ogłasza wyniki codziennego losowania lotto.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addChannelOption((opt) =>
      opt.setName('kanal')
        .setDescription('Kanał tekstowy z wynikami losowań (domyślnie: bieżący)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),

  async execute(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: '⛔ Ta komenda jest tylko dla osób z uprawnieniem „Zarządzaj serwerem".', flags: MessageFlags.Ephemeral });
      return;
    }

    const channel = interaction.options.getChannel('kanal') ?? interaction.channel;

    const me = interaction.guild.members.me;
    const perms = channel.permissionsFor(me);
    if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.SendMessages) || !perms.has(PermissionFlagsBits.EmbedLinks)) {
      await interaction.reply({
        content: `⚠️ Bob nie ma uprawnień do pisania i osadzania linków na <#${channel.id}>. Nadaj mu **Wyświetlanie kanału**, **Wysyłanie wiadomości** i **Osadzanie linków** i spróbuj ponownie. Nic nie zostało zmienione.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await lotto.setAnnounceChannel(interaction.guild.id, channel.id);

    await interaction.reply({
      content:
        `✅ Wyniki lotto będą ogłaszane na <#${channel.id}>.\n` +
        `Losowanie odbywa się codziennie o **${lotto.DRAW_HOUR}:00** (czas polski). ` +
        `Los kupiony po tej godzinie trafia do losowania następnego dnia.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
