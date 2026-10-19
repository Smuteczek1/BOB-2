const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Pokazuje aktualnie skonfigurowane kanały dla tego serwera.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const config = db.getGuildConfig(interaction.guild.id);

    if (!config) {
      await interaction.reply({
        content: '⚠️ Bot nie jest jeszcze skonfigurowany na tym serwerze. Użyj `/setup-voice-hub`.',
        ephemeral: true,
      });
      return;
    }

    const hub = config.hub_channel_id ? `<#${config.hub_channel_id}>` : '_nie ustawiono_';
    const stats = config.stats_channel_id ? `<#${config.stats_channel_id}>` : '_nie ustawiono_';

    await interaction.reply({
      content: `🔧 **Konfiguracja bota:**\n🔊 Kanał hub: ${hub}\n📊 Kanał rankingu: ${stats}`,
      ephemeral: true,
    });
  },
};
