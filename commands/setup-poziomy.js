const { SlashCommandBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const db = require('../db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup-poziomy')
    .setDescription('Tworzy kanał, na którym bot ogłasza kamienie milowe poziomów (5, 10, 15, 20, 30...).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(opt =>
      opt.setName('kategoria')
        .setDescription('Kategoria, w której ma powstać kanał (opcjonalnie). Można to zmienić później ręcznie.')
        .addChannelTypes(ChannelType.GuildCategory)
        .setRequired(false))
    .addStringOption(opt =>
      opt.setName('nazwa_kanalu')
        .setDescription('Nazwa kanału poziomów (domyślnie: 🏆-poziomy)')
        .setRequired(false)),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const category = interaction.options.getChannel('kategoria');
    const channelName = interaction.options.getString('nazwa_kanalu') ?? '🏆-poziomy';
    const guild = interaction.guild;

    try {
      const channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: category ?? null,
        topic: 'Tutaj bot ogłasza, gdy ktoś osiągnie kamień milowy poziomu (5, 10, 15, 20, 30, 40, 50, 75, 100...).',
        reason: `Kanał poziomów skonfigurowany przez ${interaction.user.tag}`,
      });

      db.setLevelsChannel(guild.id, channel.id);

      await interaction.editReply({
        content:
          `✅ Gotowe! Kanał poziomów: <#${channel.id}>\n` +
          `Bot będzie tam ogłaszał tylko kamienie milowe (5, 10, 15, 20, 30, 40, 50, 75, 100, 150, 200, ` +
          `300, 400, 500, 600, 700, 800, 900, 1000, 1100...), a nie każdy pojedynczy poziom.\n\n` +
          `Możesz swobodnie zmienić nazwę i kategorię tego kanału — bot rozpoznaje go po ID.`,
      });
    } catch (err) {
      console.error(err);
      await interaction.editReply({
        content: '❌ Nie udało się utworzyć kanału. Sprawdź, czy bot ma uprawnienie **Zarządzaj kanałami**.',
      });
    }
  },
};
