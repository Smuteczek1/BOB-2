const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../db');
const { levelForXp, xpNeededForLevel } = require('../utils/leveling');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('poziom')
    .setDescription('Pokazuje Twój aktualny poziom i XP (albo czyjś, jeśli podasz użytkownika).')
    .addUserOption(opt =>
      opt.setName('uzytkownik')
        .setDescription('Czyj poziom sprawdzić (domyślnie: Twój)')
        .setRequired(false)),

  async execute(interaction) {
    const target = interaction.options.getUser('uzytkownik') ?? interaction.user;
    const row = await db.getUserLevel(interaction.guild.id, target.id);

    if (!row) {
      await interaction.reply({
        content: `📊 **${target.username}** nie ma jeszcze żadnego XP na tym serwerze.`,
        ephemeral: true,
      });
      return;
    }

    const level = levelForXp(row.xp);
    const xpForCurrentLevel = sumXpUpTo(level);
    const xpForNextLevel = xpForCurrentLevel + xpNeededForLevel(level + 1);
    const xpIntoLevel = row.xp - xpForCurrentLevel;
    const xpNeeded = xpForNextLevel - xpForCurrentLevel;

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setAuthor({ name: target.username, iconURL: target.displayAvatarURL() })
      .setDescription(
        `🏅 Poziom: **${level}**\n` +
        `✨ XP: **${row.xp}** (${xpIntoLevel} / ${xpNeeded} do poziomu ${level + 1})`,
      );

    await interaction.reply({ embeds: [embed] });
  },
};

function sumXpUpTo(level) {
  let total = 0;
  for (let lvl = 1; lvl <= level; lvl++) {
    total += xpNeededForLevel(lvl);
  }
  return total;
}
