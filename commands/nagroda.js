const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const db = require('../db');
const { rollDailyReward, formatCoins, CURRENCY, DAILY_TIERS } = require('../utils/economy');

// Odstęp między klatkami animacji (ms). Można zmienić w .env: CHEST_FRAME_DELAY_MS
const FRAME_DELAY_MS = Number(process.env.CHEST_FRAME_DELAY_MS ?? 1300);

// Kolory "barowe": od ciemnego drewna do rozżarzonego złota
const GOLD = 0xd4af37;

// Klatki animacji: każda to jedna edycja tej samej, publicznej wiadomości
const FRAMES = [
  { color: 0x2b1d0e, bar: '▱▱▱▱▱▱', text: '📦 Skrzynia ląduje na barowej ladzie. Bob przeciera szklankę i patrzy spod oka...' },
  { color: 0x4a3216, bar: '▰▰▱▱▱▱', text: '📦 Skrzynia zaczyna się trząść... 〰️ Dzwonią butelki na półce.' },
  { color: 0x7a5420, bar: '▰▰▰▰▱▱', text: '🔒 Zamek trzeszczy, spod wieka przebija się światło...' },
  { color: GOLD,     bar: '▰▰▰▰▰▰', text: '✨ **KLIK!** Wieko odskakuje...' },
];

// Komentarz Boba do każdej rzadkości (kolejność jak w DAILY_TIERS)
const BOB_QUIPS = [
  'Bywało gorzej. Ja kiedyś dostawałem same puste butelki.',
  'Przyzwoicie, starczy na porządną kolację.',
  'O, niezłe! Postaw koledze kolejkę, nie bądź skąpy.',
  'Legendarna! Takie rzeczy się pamięta latami.',
  'MITYCZNA?! Chowaj to szybko, zanim ja to zobaczę!',
  'Boska skrzynia... Przysięgam, że dzisiaj nie piłem.',
  'VOID. Czegoś takiego nie widziałem nigdy. Nikomu nie mów.',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function frameEmbed(frame, user) {
  return new EmbedBuilder()
    .setColor(frame.color)
    .setTitle('🎁 Dzienna skrzynia')
    .setDescription(`${frame.text}\n\n\`${frame.bar}\``)
    .setFooter({ text: `Skrzynię otwiera: ${user.displayName ?? user.username}` });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('nagroda')
    .setDescription('Odbierz dzienną skrzynię z monetami (reset o północy, czas polski)!'),

  async execute(interaction) {
    const guildId = interaction.guild.id;
    const userId = interaction.user.id;

    // 1) Losowanie i wypłata dzieją się od razu, w jednej transakcji w bazie. Animacja to tylko widowisko,
    //    więc nawet gdyby coś poszło nie tak w trakcie, nagroda jest już bezpiecznie zapisana.
    const { tier, amount } = rollDailyReward();
    const result = await db.claimDailyCoins(guildId, userId, amount);

    if (!result.claimed) {
      await interaction.reply({
        content: '⏰ Odebrałeś/aś już dzisiejszą skrzynię! Wróć po północy (00:00).',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // 2) Publiczna animacja: jedna wiadomość edytowana klatka po klatce, widoczna dla wszystkich na kanale
    const noPings = { parse: [] };
    let animationOk = true;

    try {
      await interaction.reply({
        content: `${interaction.user} otwiera dzienną skrzynię!`,
        embeds: [frameEmbed(FRAMES[0], interaction.user)],
        allowedMentions: noPings,
      });

      for (let i = 1; i < FRAMES.length; i++) {
        await sleep(FRAME_DELAY_MS);
        await interaction.editReply({ embeds: [frameEmbed(FRAMES[i], interaction.user)] });
      }
      await sleep(FRAME_DELAY_MS);
    } catch (err) {
      // Np. ktoś usunął wiadomość w trakcie. Nagroda i tak jest już przyznana, więc pokażemy wynik osobno.
      animationOk = false;
      console.error('Animacja skrzyni przerwana:', err.message);
    }

    // 3) Odsłonięcie nagrody
    const tierIndex = DAILY_TIERS.indexOf(tier);
    const isBig = tierIndex >= 4; // Mityczna i wyżej
    const reveal = new EmbedBuilder()
      .setColor(tier.color)
      .setTitle(isBig ? '🎆 NIESAMOWITE! 🎆' : '🎁 Skrzynia otwarta!')
      .setDescription(
        `Wypadło: **${tier.name}**\n\n` +
        `${CURRENCY.emoji} Nagroda: ${formatCoins(amount)}\n` +
        `Saldo: ${formatCoins(result.balance)}\n\n` +
        `🥃 *Bob: ${BOB_QUIPS[tierIndex] ?? ''}*`,
      )
      .setFooter({ text: `Skrzynię otworzył(a): ${interaction.user.displayName ?? interaction.user.username} • kolejna jutro po 00:00` })
      .setTimestamp();

    const payload = {
      content: isBig ? `🎉 ${interaction.user} wylosował(a) **${tier.name}**!` : `${interaction.user}`,
      embeds: [reveal],
      allowedMentions: noPings,
    };

    try {
      if (animationOk) await interaction.editReply(payload);
      else await interaction.followUp(payload);
    } catch (err) {
      console.error('Nie udało się pokazać nagrody ze skrzyni:', err.message);
    }
  },
};
