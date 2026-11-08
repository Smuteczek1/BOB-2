const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const db = require('../db');
const { CURRENCY, formatCoins, reasonLabel } = require('../utils/economy');
const skarbonka = require('../utils/skarbonka');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('portfel')
    .setDescription('Pokazuje stan portfela (Twojego lub wybranej osoby).')
    .addUserOption((opt) =>
      opt.setName('uzytkownik').setDescription('Czyj portfel pokazać (domyślnie Twój)').setRequired(false),
    ),

  async execute(interaction) {
    const target = interaction.options.getUser('uzytkownik') ?? interaction.user;
    const isSelf = target.id === interaction.user.id;

    if (target.bot) {
      await interaction.reply({
        content: 'Boty nie mają portfeli. Bob też nie, przegrał wszystko w ruletce. 🥃',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const guildId = interaction.guild.id;

    // Skarbonka: właściciel dostaje odsetki przy otwarciu własnego portfela (raz dziennie, do 3 dni wstecz)
    let interest = null;
    if (isSelf) interest = await skarbonka.collect(guildId, target.id).catch((err) => { console.error('Skarbonka:', err); return null; });

    const account = await db.getEconomyAccount(guildId, target.id);

    const balance = Number(account?.balance ?? 0);
    const totalEarned = Number(account?.total_earned ?? 0);

    const embed = new EmbedBuilder()
      .setColor(0xf1c40f)
      .setAuthor({
        name: `Portfel: ${target.displayName ?? target.username}`,
        iconURL: target.displayAvatarURL(),
      })
      .setDescription(`${CURRENCY.emoji} Saldo: ${formatCoins(balance)}`)
      .addFields({ name: 'Zarobione łącznie', value: totalEarned.toLocaleString('pl-PL'), inline: true });

    // Historię operacji widzi tylko właściciel portfela
    if (isSelf) {
      const txs = await db.getRecentTransactions(guildId, target.id, 5);
      const lines = txs.length
        ? txs.map((t) => {
            const amount = Number(t.amount);
            const sign = amount >= 0 ? '+' : '−';
            const when = Math.floor(Number(t.created_at) / 1000);
            return `${sign}${Math.abs(amount).toLocaleString('pl-PL')} · ${reasonLabel(t.reason)} · <t:${when}:R>`;
          }).join('\n')
        : '_Brak operacji. Odbierz skrzynię komendą `/nagroda`!_';
      embed.addFields({ name: 'Ostatnie operacje', value: lines });
    }

    if (interest?.ok) {
      embed.addFields({ name: '🐷 Skarbonka', value: `Odsetki: +${formatCoins(interest.amount)} (poziom ${interest.level}${interest.days > 1 ? `, za ${interest.days} dni` : ''})` });
    }

    await interaction.reply({ embeds: [embed] });
  },
};
