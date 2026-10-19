const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const db = require('../db');
const { rollDailyReward, formatCoins, CURRENCY } = require('../utils/economy');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('nagroda')
    .setDescription('Odbierz dzienną skrzynię z monetami (reset o północy, czas polski)!'),

  async execute(interaction) {
    const guildId = interaction.guild.id;
    const userId = interaction.user.id;

    // Losujemy z góry; jeśli okaże się, że nagroda była już dziś odebrana, wynik losowania po prostu przepada.
    const { tier, amount } = rollDailyReward();

    // Sprawdzenie "czy już odebrano" i wypłata dzieją się w jednej transakcji w bazie,
    // więc szybkie podwójne kliknięcie nie da podwójnej nagrody.
    const result = await db.claimDailyCoins(guildId, userId, amount);

    if (!result.claimed) {
      await interaction.reply({
        content: '⏰ Odebrałeś/aś już dzisiejszą skrzynię! Wróć po północy (00:00).',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('🎁 Dzienna skrzynia')
      .setColor(tier.color)
      .setDescription(
        `Udało Ci się wyciągnąć: **${tier.name}**!\n\n` +
        `${CURRENCY.emoji} Twoja nagroda: ${formatCoins(amount)}\n` +
        `Saldo: ${formatCoins(result.balance)}`,
      )
      .setFooter({ text: 'Kolejną skrzynię odbierzesz jutro po 00:00!' })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  },
};
