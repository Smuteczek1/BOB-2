const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder } = require('discord.js');
const db = require('../db');
const {
  buildAddModal,
  buildPointSelectMenu,
  RULE_POINT_EDIT_SELECT_ID,
  RULE_POINT_DELETE_SELECT_ID,
} = require('../utils/rulePoints');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('regulamin-punkt')
    .setDescription('Zarządza punktami regulaminu.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub
      .setName('dodaj')
      .setDescription('Dodaje nowy punkt regulaminu (otworzy się okno do wypełnienia).'))
    .addSubcommand(sub => sub
      .setName('edytuj')
      .setDescription('Edytuje istniejący punkt regulaminu.'))
    .addSubcommand(sub => sub
      .setName('usun')
      .setDescription('Usuwa punkt regulaminu.'))
    .addSubcommand(sub => sub
      .setName('lista')
      .setDescription('Pokazuje podgląd wszystkich punktów regulaminu.')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    if (sub === 'dodaj') {
      await interaction.showModal(buildAddModal());
      return;
    }

    if (sub === 'edytuj') {
      const row = await buildPointSelectMenu(guildId, RULE_POINT_EDIT_SELECT_ID, 'Wybierz punkt do edycji...');
      if (!row) {
        await interaction.reply({
          content: 'ℹ️ Nie masz jeszcze żadnych punktów regulaminu — dodaj pierwszy przez `/regulamin-punkt dodaj`.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.reply({
        content: 'Który punkt chcesz edytować?',
        components: [row],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'usun') {
      const row = await buildPointSelectMenu(guildId, RULE_POINT_DELETE_SELECT_ID, 'Wybierz punkt do usunięcia...');
      if (!row) {
        await interaction.reply({
          content: 'ℹ️ Nie masz jeszcze żadnych punktów regulaminu.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.reply({
        content: '⚠️ Który punkt chcesz usunąć? (tej akcji nie da się cofnąć)',
        components: [row],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'lista') {
      const points = await db.getRulePoints(guildId);

      if (!points || points.length === 0) {
        await interaction.reply({
          content: 'ℹ️ Nie masz jeszcze żadnych punktów regulaminu — dodaj pierwszy przez `/regulamin-punkt dodaj`.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('📋 Podgląd punktów regulaminu')
        .setDescription(
          points
            .map((p, i) => `**${i + 1}. ${p.title}**\n${p.summary}${p.details ? '\n_(ma rozwinięcie)_' : ''}`)
            .join('\n\n'),
        )
        .setFooter({ text: `Łącznie punktów: ${points.length}. Gotowe? Użyj /setup-regulamin publikuj.` });

      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
  },
};
