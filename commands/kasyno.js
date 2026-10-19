const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const db = require('../db');
const { formatCoins, CURRENCY } = require('../utils/economy');
const casino = require('../utils/casino');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Komentarze Boba (byłego bywalca kasyn)
const BOB_WIN = [
  'No proszę... Dziś ci się udało. Nie przyzwyczajaj się.',
  'Kasyno zawsze oddaje, żeby zabrać więcej. Ja to wiem najlepiej.',
  'Wygrałeś? To zostaw to i idź do domu. Nie posłuchasz, prawda?',
  'Ładnie! Ja miałem tak samo, zanim straciłem wszystko.',
];
const BOB_BIG_WIN = [
  'CO?! Ty sobie chyba żartujesz... Ja przez trzydzieści lat takiego nie widziałem.',
  'Odłóż to i uciekaj! Nikt nie wygrywa tyle dwa razy.',
];
const BOB_LOSE = [
  'Jeszcze jeden obrót, tak? Znam to zdanie aż za dobrze.',
  'Kasyno nie przegrywa. Zapamiętaj to sobie.',
  'Ja też tak zaczynałem. Teraz rozmawiam z butelką.',
  'Spokojnie, to tylko monety. Mój dom też był tylko budynkiem.',
  'Tym razem się nie udało. Następnym też nie, ale kto by liczył.',
];
const BOB_PUSH = ['Ani w tę, ani w tamtą stronę. Bywa.', 'Odzyskałeś część. To się liczy jako zwycięstwo, jeśli nie masz ambicji.'];

function betOption(opt) {
  return opt
    .setName('stawka')
    .setDescription(`Ile monet stawiasz (${casino.MIN_BET}-${casino.MAX_BET})`)
    .setRequired(true)
    .setMinValue(casino.MIN_BET)
    .setMaxValue(casino.MAX_BET);
}

const fmtPct = (x) => `${(x * 100).toFixed(1)}%`;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('kasyno')
    .setDescription('Kasyno Boba: zaryzykuj swoje monety!')
    .addSubcommand((sub) =>
      sub.setName('automat')
        .setDescription('Jednoręki bandyta: 3 bębny, wygrane do x250.')
        .addIntegerOption(betOption))
    .addSubcommand((sub) =>
      sub.setName('ruletka')
        .setDescription('Ruletka europejska (0-36): kolor, parzystość, połowa albo konkretny numer.')
        .addStringOption((opt) =>
          opt.setName('zaklad')
            .setDescription('Na co stawiasz')
            .setRequired(true)
            .addChoices(
              { name: '🔴 Czerwone (x2)', value: 'czerwone' },
              { name: '⚫ Czarne (x2)', value: 'czarne' },
              { name: 'Parzyste (x2)', value: 'parzyste' },
              { name: 'Nieparzyste (x2)', value: 'nieparzyste' },
              { name: 'Niskie 1-18 (x2)', value: 'niskie' },
              { name: 'Wysokie 19-36 (x2)', value: 'wysokie' },
              { name: 'Konkretny numer (x36)', value: 'numer' },
            ))
        .addIntegerOption(betOption)
        .addIntegerOption((opt) =>
          opt.setName('numer')
            .setDescription('Numer 0-36 (tylko gdy zakład to "Konkretny numer")')
            .setMinValue(0)
            .setMaxValue(36)))
    .addSubcommand((sub) =>
      sub.setName('moneta')
        .setDescription('Orzeł czy reszka: podwajasz stawkę albo ją tracisz.')
        .addStringOption((opt) =>
          opt.setName('strona')
            .setDescription('Na co stawiasz')
            .setRequired(true)
            .addChoices({ name: '🦅 Orzeł', value: 'orzel' }, { name: '🪙 Reszka', value: 'reszka' }))
        .addIntegerOption(betOption))
    .addSubcommand((sub) =>
      sub.setName('zasady').setDescription('Wypłaty i szanse we wszystkich grach.')),

  async execute(interaction) {
    if (!interaction.guild) {
      await interaction.reply({ content: 'Kasyno działa tylko na serwerze.', flags: MessageFlags.Ephemeral });
      return;
    }

    const sub = interaction.options.getSubcommand();
    if (sub === 'zasady') return showRules(interaction);

    // Walidacja zakładu na numer, zanim cokolwiek pobierzemy
    let rouletteKind = null;
    let rouletteNumber = null;
    if (sub === 'ruletka') {
      rouletteKind = interaction.options.getString('zaklad');
      rouletteNumber = interaction.options.getInteger('numer');
      if (rouletteKind === 'numer' && rouletteNumber === null) {
        await interaction.reply({ content: '⚠️ Wybrałeś/aś zakład na numer, więc podaj też `numer` (0-36).', flags: MessageFlags.Ephemeral });
        return;
      }
    }

    const guildId = interaction.guild.id;
    const user = interaction.user;
    const bet = interaction.options.getInteger('stawka');

    const start = casino.tryStartGame(guildId, user.id);
    if (!start.ok) {
      await interaction.reply({ content: start.message, flags: MessageFlags.Ephemeral });
      return;
    }

    try {
      await interaction.deferReply();

      if (sub === 'automat') await playSlots(interaction, guildId, user, bet);
      else if (sub === 'ruletka') await playRoulette(interaction, guildId, user, bet, rouletteKind, rouletteNumber);
      else if (sub === 'moneta') await playCoin(interaction, guildId, user, bet, interaction.options.getString('strona'));
    } finally {
      casino.finishGame(guildId, user.id);
    }
  },
};

// Wspólne: wynik gry -> kolor, nagłówek i komentarz Boba
function outcomeStyle(bet, payout) {
  if (payout > bet * 20) return { color: 0xf1c40f, head: '💰 JACKPOT!', quip: pick(BOB_BIG_WIN) };
  if (payout > bet) return { color: 0x2ecc71, head: '✅ Wygrana!', quip: pick(BOB_WIN) };
  if (payout === bet) return { color: 0x95a5a6, head: '🤝 Zwrot stawki', quip: pick(BOB_PUSH) };
  if (payout > 0) return { color: 0xe67e22, head: '🟠 Częściowy zwrot', quip: pick(BOB_PUSH) };
  return { color: 0xe74c3c, head: '❌ Przegrana', quip: pick(BOB_LOSE) };
}

function resultLines(bet, payout, balance) {
  const net = payout - bet;
  const netText = net > 0 ? `+${formatCoins(net)}` : net < 0 ? `−${formatCoins(-net)}` : 'bez zmian';
  return `Stawka: ${formatCoins(bet)}\nWynik: ${netText}\nSaldo: ${formatCoins(balance)}`;
}

// Gdy nie stać na stawkę: pokazujemy saldo, nic nie zostało pobrane
async function replyInsufficient(interaction, guildId, userId) {
  const account = await db.getEconomyAccount(guildId, userId);
  const balance = account ? Number(account.balance) : 0;
  await interaction.editReply({
    content: `💸 Nie stać Cię na taką stawkę. Masz ${formatCoins(balance)}. Odbierz \`/nagroda\`, jeśli jeszcze dziś nie odebrałeś/aś.`,
    embeds: [],
  });
}

// ---------------- AUTOMAT ----------------
async function playSlots(interaction, guildId, user, bet) {
  const spin = casino.spinSlots();
  const payout = Math.floor(bet * spin.multiplier);

  const balance = await casino.settleBet(guildId, user.id, bet, payout, 'casino_automat');
  if (balance === null) return replyInsufficient(interaction, guildId, user.id);

  const frame = (reels, footer) =>
    new EmbedBuilder()
      .setColor(0x7a5420)
      .setTitle('🎰 Automat Boba')
      .setDescription(`# ${reels.join(' | ')}`)
      .setFooter({ text: footer });

  const header = `${user} kręci automatem!`;
  await interaction.editReply({ content: header, embeds: [frame(['❔', '❔', '❔'], `Stawka: ${bet} | gra: ${user.displayName ?? user.username}`)], allowedMentions: { parse: [] } });
  await sleep(900);
  await interaction.editReply({ embeds: [frame([spin.reels[0], '❔', '❔'], 'Bębny się kręcą...')] }).catch(() => null);
  await sleep(900);
  await interaction.editReply({ embeds: [frame([spin.reels[0], spin.reels[1], '❔'], 'Jeszcze jeden...')] }).catch(() => null);
  await sleep(1000);

  const style = outcomeStyle(bet, payout);
  const label = spin.kind === 'triple' ? `Trzy takie same: x${spin.multiplier}` : spin.kind === 'pair' ? `Para: x${spin.multiplier}` : 'Brak układu';
  const embed = new EmbedBuilder()
    .setColor(style.color)
    .setTitle(`🎰 ${style.head}`)
    .setDescription(`# ${spin.reels.join(' | ')}\n${label}\n\n${resultLines(bet, payout, balance)}\n\n🥃 *Bob: ${style.quip}*`);
  await interaction.editReply({ content: header, embeds: [embed], allowedMentions: { parse: [] } });
}

// ---------------- RULETKA ----------------
async function playRoulette(interaction, guildId, user, bet, kind, chosenNumber) {
  const spin = casino.spinRoulette(kind, chosenNumber);
  const payout = bet * spin.multiplier;

  const balance = await casino.settleBet(guildId, user.id, bet, payout, 'casino_ruletka');
  if (balance === null) return replyInsufficient(interaction, guildId, user.id);

  const def = casino.ROULETTE_BETS[kind];
  const betLabel = kind === 'numer' ? `Numer ${chosenNumber} (x36)` : `${def.label} (x${def.multiplier})`;
  const header = `${user} stawia na: **${betLabel}**`;

  await interaction.editReply({
    content: header,
    embeds: [
      new EmbedBuilder()
        .setColor(0x7a5420)
        .setTitle('🎡 Ruletka')
        .setDescription('Kula wiruje po kole... 🌀\n\n# ❔')
        .setFooter({ text: `Stawka: ${bet}` }),
    ],
    allowedMentions: { parse: [] },
  });
  await sleep(2200);

  const style = outcomeStyle(bet, payout);
  const embed = new EmbedBuilder()
    .setColor(style.color)
    .setTitle(`🎡 ${style.head}`)
    .setDescription(`Kula zatrzymała się na:\n# ${spin.color} ${spin.number}\n\n${resultLines(bet, payout, balance)}\n\n🥃 *Bob: ${spin.number === 0 ? 'Zero. Dom wygrywa. Zawsze wygrywa.' : style.quip}*`);
  await interaction.editReply({ content: header, embeds: [embed], allowedMentions: { parse: [] } });
}

// ---------------- ORZEŁ / RESZKA ----------------
async function playCoin(interaction, guildId, user, bet, side) {
  const flip = casino.flipCoin(side);
  const payout = bet * flip.multiplier;

  const balance = await casino.settleBet(guildId, user.id, bet, payout, 'casino_moneta');
  if (balance === null) return replyInsufficient(interaction, guildId, user.id);

  const names = { orzel: '🦅 Orzeł', reszka: '🪙 Reszka' };
  const header = `${user} rzuca monetą i stawia na: **${names[side]}**`;

  await interaction.editReply({
    content: header,
    embeds: [new EmbedBuilder().setColor(0x7a5420).setTitle('🪙 Rzut monetą').setDescription('Moneta wirująca w powietrzu... 🌀\n\n# ❔').setFooter({ text: `Stawka: ${bet}` })],
    allowedMentions: { parse: [] },
  });
  await sleep(1600);

  const style = outcomeStyle(bet, payout);
  const embed = new EmbedBuilder()
    .setColor(style.color)
    .setTitle(`🪙 ${style.head}`)
    .setDescription(`Wypadło:\n# ${names[flip.result]}\n\n${resultLines(bet, payout, balance)}\n\n🥃 *Bob: ${style.quip}*`);
  await interaction.editReply({ content: header, embeds: [embed], allowedMentions: { parse: [] } });
}

// ---------------- ZASADY ----------------
async function showRules(interaction) {
  const slotLines = casino.SLOT_SYMBOLS.map((s) => `${s.emoji}${s.emoji}${s.emoji} → x${s.triple}`).join('\n');
  const pairLines = Object.entries(casino.SLOT_PAIR).map(([emoji, mult]) => `dwie ${emoji} → x${mult}`).join(', ');

  const embed = new EmbedBuilder()
    .setColor(0x7a5420)
    .setTitle('🎲 Kasyno Boba: zasady')
    .setDescription(
      `Stawki: **${casino.MIN_BET}-${casino.MAX_BET}** ${CURRENCY.emoji}. Wygrana to mnożnik stawki (stawka wraca w ramach mnożnika).\n` +
      'Wszystkie losowania są uczciwe (kryptograficzny RNG), a kasyno ma niewielką przewagę.',
    )
    .addFields(
      {
        name: `🎰 Automat (zwrot ${fmtPct(casino.slotRtp())})`,
        value: `${slotLines}\n${pairLines}`,
        inline: true,
      },
      {
        name: `🎡 Ruletka (zwrot ${fmtPct(casino.rouletteRtp('czerwone'))})`,
        value: 'Kolor, parzystość, połowa: **x2**\nKonkretny numer: **x36**\nZero przegrywa wszystko.',
        inline: true,
      },
      {
        name: `🪙 Orzeł/reszka (zwrot ${fmtPct(casino.coinRtp())})`,
        value: 'Szansa **48%**, wygrana **x2**.',
        inline: true,
      },
    )
    .setFooter({ text: 'Graj z głową. To tylko monety, ale Bob przestrzega: dom zawsze wygrywa w końcu.' });

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
