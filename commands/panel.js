const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { handleOpenPanel } = require('../utils/panel');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Otwiera panel konfiguracji serwera (prywatny, tylko dla Ciebie).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    await handleOpenPanel(interaction);
  },
};
