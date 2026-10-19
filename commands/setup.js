const { SlashCommandBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const db = require('../db');
const { updateLeaderboard } = require('../utils/leaderboard');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup-voice-hub')
    .setDescription('Tworzy kanał głosowy "twórca kanałów" oraz kanał tekstowy z rankingiem czasu rozmów.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(opt =>
      opt.setName('kategoria')
        .setDescription('Kategoria, w której mają powstać kanały (opcjonalnie). Można to zmienić później ręcznie.')
        .addChannelTypes(ChannelType.GuildCategory)
        .setRequired(false))
    .addStringOption(opt =>
      opt.setName('nazwa_hub')
        .setDescription('Nazwa kanału głosowego do tworzenia nowych kanałów (domyślnie: ➕ Utwórz kanał)')
        .setRequired(false))
    .addStringOption(opt =>
      opt.setName('nazwa_rankingu')
        .setDescription('Nazwa kanału tekstowego z rankingiem (domyślnie: 📊-ranking-rozmow)')
        .setRequired(false)),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const category = interaction.options.getChannel('kategoria');
    const hubName = interaction.options.getString('nazwa_hub') ?? '➕ Utwórz kanał';
    const statsName = interaction.options.getString('nazwa_rankingu') ?? '📊-ranking-rozmow';

    const guild = interaction.guild;

    try {
      const hubChannel = await guild.channels.create({
        name: hubName,
        type: ChannelType.GuildVoice,
        parent: category ?? null,
        reason: `Kanał hub skonfigurowany przez ${interaction.user.tag}`,
      });

      const statsChannel = await guild.channels.create({
        name: statsName,
        type: ChannelType.GuildText,
        parent: category ?? null,
        reason: `Kanał rankingu skonfigurowany przez ${interaction.user.tag}`,
      });

      db.upsertGuildConfig(guild.id, {
        hubChannelId: hubChannel.id,
        statsChannelId: statsChannel.id,
      });

      await updateLeaderboard(interaction.client, guild.id);

      await interaction.editReply({
        content:
          `✅ Gotowe!\n` +
          `🔊 Kanał tworzący nowe pokoje: <#${hubChannel.id}>\n` +
          `📊 Kanał z rankingiem: <#${statsChannel.id}>\n\n` +
          `Możesz teraz swobodnie zmienić nazwę, przenieść do innej kategorii lub zmienić kolejność tych kanałów — ` +
          `bot rozpoznaje je po ID, więc dalej będą działać poprawnie.`,
      });
    } catch (err) {
      console.error(err);
      await interaction.editReply({
        content: '❌ Nie udało się utworzyć kanałów. Sprawdź, czy bot ma uprawnienie **Zarządzaj kanałami**.',
      });
    }
  },
};
