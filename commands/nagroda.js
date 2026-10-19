const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const db = require('../db');
const { rollDailyReward, formatCoins, CURRENCY, DAILY_TIERS } = require('../utils/economy');

// Odstęp między etapami (ms). Discord ogranicza tempo edycji wiadomości i potrafi pomijać szybkie zmiany,
// dlatego etapy są tylko 3 i dość wolne. Można zmienić w .env: CHEST_FRAME_DELAY_MS
const STAGE_DELAY_MS = Number(process.env.CHEST_FRAME_DELAY_MS ?? 2000);
const TOTAL_STAGES = 3;

// Duży pasek w kolorach rzadkości: jeden kwadrat na każdą rzadkość, w kolejności z DAILY_TIERS.
// Ikonę bierzemy z początku nazwy rzadkości (np. "⚪ Pospolita Skrzynia" -> "⚪"), więc zmiana w economy.js
// automatycznie zmienia też pasek.
const TIER_SQUARES = DAILY_TIERS.map((t) => t.name.split(' ')[0]);
const EMPTY_SQUARE = '⬛';

function bar(lit) {
  return TIER_SQUARES.map((sq, i) => (i < lit ? sq : EMPTY_SQUARE)).join(' ');
}

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

// Etapy 1 i 2 (etap 3 to odsłonięcie nagrody). Pasek tylko rośnie: 0 -> ok. połowa drogi do wyniku -> cały wynik.
const STAGES = [
  {
    color: 0x2b1d0e,
    text: '📦 Skrzynia ląduje na barowej ladzie. Bob przeciera szklankę i patrzy spod oka...',
    litFor: () => 0,
  },
  {
    color: 0x7a5420,
    text: '🔒 Zamek trzeszczy, wieko drży, a spod niego przebija się światło... ✨',
    litFor: (tierIndex) => Math.max(1, Math.ceil((tierIndex + 1) / 2)),
  },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nameOf = (user) => user.displayName ?? user.username;

function stageEmbed(stageNumber, user, tierIndex) {
  const stage = STAGES[stageNumber - 1];
  return new EmbedBuilder()
    .setColor(stage.color)
    .setTitle('🎁 Dzienna skrzynia')
    .setDescription(`${stage.text}\n\n# ${bar(stage.litFor(tierIndex))}`)
    .setFooter({ text: `Etap ${stageNumber}/${TOTAL_STAGES} • skrzynię otwiera: ${nameOf(user)}` });
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

    // 2) Publiczna animacja: jedna wiadomość, 3 etapy, widoczna dla wszystkich na kanale
    const tierIndex = DAILY_TIERS.indexOf(tier);
    const noPings = { parse: [] };
    let animationOk = true;

    try {
      await interaction.reply({
        content: `${interaction.user} otwiera dzienną skrzynię!`,
        embeds: [stageEmbed(1, interaction.user, tierIndex)],
        allowedMentions: noPings,
      });
      await sleep(STAGE_DELAY_MS);
      await interaction.editReply({ embeds: [stageEmbed(2, interaction.user, tierIndex)] });
      await sleep(STAGE_DELAY_MS);
    } catch (err) {
      // Np. ktoś usunął wiadomość w trakcie. Nagroda jest już przyznana, więc pokażemy wynik osobno.
      animationOk = false;
      console.error('Animacja skrzyni przerwana:', err.message);
    }

    // 3) Etap 3/3: odsłonięcie. Pasek pokazuje, do której rzadkości "doszła" skrzynia.
    const isBig = tierIndex >= 4; // Mityczna i wyżej
    const reveal = new EmbedBuilder()
      .setColor(tier.color)
      .setTitle(isBig ? '🎆 NIESAMOWITE! 🎆' : '🎁 Skrzynia otwarta!')
      .setDescription(
        `**KLIK!** Wypadło: **${tier.name}**\n\n` +
        `# ${bar(tierIndex + 1)}\n\n` +
        `${CURRENCY.emoji} Nagroda: ${formatCoins(amount)}\n` +
        `Saldo: ${formatCoins(result.balance)}\n\n` +
        `🥃 *Bob: ${BOB_QUIPS[tierIndex] ?? ''}*`,
      )
      .setFooter({ text: `Etap ${TOTAL_STAGES}/${TOTAL_STAGES} • skrzynię otworzył(a): ${nameOf(interaction.user)} • kolejna jutro po 00:00` })
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
