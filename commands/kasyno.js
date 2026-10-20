const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} = require('discord.js');
const db = require('../db');
const { formatCoins, CURRENCY } = require('../utils/economy');
const casino = require('../utils/casino');

// ============================================================
//  /kasyno: PRYWATNE menu (widzisz je tylko Ty), ale każda rozegrana gra
//  ląduje PUBLICZNIE na kanale, żeby wszyscy widzieli, jak grasz.
// ============================================================

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const noPings = { parse: [] };

const MENU_IDLE_MS = 5 * 60 * 1000; // menu gaśnie po 5 min bez klikania
const MENU_MAX_MS = 14 * 60 * 1000; // twardy limit (token interakcji ważny 15 min)
const DEFAULT_BET = Math.min(casino.MAX_BET, Math.max(casino.MIN_BET, 100));

const GAMES = {
  automat: { label: 'Automat', emoji: '🎰', blurb: '3 bębny, wygrane do x250. Dwie wiśnie lub cytryny też coś zwracają.' },
  ruletka: { label: 'Ruletka', emoji: '🎡', blurb: 'Ruletka europejska (0-36). Kolor, parzystość lub połowa płacą x2, numer x36.' },
  moneta: { label: 'Orzeł/reszka', emoji: '🪙', blurb: 'Podwajasz stawkę albo ją tracisz. Szansa 48%.' },
};
const SIDE_LABELS = { orzel: '🦅 Orzeł', reszka: '🪙 Reszka' };

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

const fmtPct = (x) => `${(x * 100).toFixed(1)}%`;

// ---------------- WIDOK MENU ----------------

function rulesEmbed() {
  const slotLines = casino.SLOT_SYMBOLS.map((s) => `${s.emoji}${s.emoji}${s.emoji} → x${s.triple}`).join('\n');
  const pairLines = Object.entries(casino.SLOT_PAIR).map(([emoji, mult]) => `dwie ${emoji} → x${mult}`).join(', ');

  return new EmbedBuilder()
    .setColor(0x7a5420)
    .setTitle('📖 Kasyno Boba: zasady')
    .setDescription(
      `Stawki: **${casino.MIN_BET}-${casino.MAX_BET}** ${CURRENCY.emoji}. Wygrana to mnożnik stawki (stawka wraca w ramach mnożnika).\n` +
      'Losowania są uczciwe (kryptograficzny RNG), a kasyno ma niewielką przewagę.',
    )
    .addFields(
      { name: `🎰 Automat (zwrot ${fmtPct(casino.slotRtp())})`, value: `${slotLines}\n${pairLines}`, inline: true },
      {
        name: `🎡 Ruletka (zwrot ${fmtPct(casino.rouletteRtp('czerwone'))})`,
        value: 'Kolor, parzystość, połowa: **x2**\n🟢 Zielone (zero) lub konkretny numer: **x36**\nZero przegrywa wszystkie inne zakłady.',
        inline: true,
      },
      { name: `🪙 Orzeł/reszka (zwrot ${fmtPct(casino.coinRtp())})`, value: 'Szansa **48%**, wygrana **x2**.', inline: true },
    )
    .setFooter({ text: 'Graj z głową. To tylko monety, ale dom w końcu zawsze wygrywa.' });
}

function betLabelFor(state) {
  if (state.game === 'ruletka') {
    return state.rouletteKind === 'numer'
      ? `Numer ${state.rouletteNumber} (x36)`
      : `${casino.ROULETTE_BETS[state.rouletteKind].label} (x${casino.ROULETTE_BETS[state.rouletteKind].multiplier})`;
  }
  if (state.game === 'moneta') return SIDE_LABELS[state.coinSide];
  return null;
}

// Buduje cały widok menu (embed + przyciski). balance podajemy z cache albo pobieramy z bazy.
async function buildPanel(session, { disabled = false } = {}) {
  const { state } = session;
  if (!disabled || state.balance === null) {
    const account = await db.getEconomyAccount(session.guildId, session.user.id);
    state.balance = account ? Number(account.balance) : 0;
  }

  let embed;
  if (state.view === 'rules') {
    embed = rulesEmbed();
  } else if (state.view === 'game' && state.game) {
    const game = GAMES[state.game];
    const lines = [`${game.blurb}`, '', `Stawka: ${formatCoins(state.bet)}`];
    const choice = betLabelFor(state);
    if (choice) lines.push(`Zakład: **${choice}**`);
    lines.push(`Saldo: ${formatCoins(state.balance)}`);
    embed = new EmbedBuilder()
      .setColor(0x7a5420)
      .setTitle(`${game.emoji} ${game.label}`)
      .setDescription(lines.join('\n'))
      .setFooter({ text: 'To menu widzisz tylko Ty. Gra pojawi się publicznie na czacie.' });
  } else {
    embed = new EmbedBuilder()
      .setColor(0x7a5420)
      .setTitle('🎲 Kasyno Boba')
      .setDescription(
        'Wybierz grę poniżej. **To menu widzisz tylko Ty**, ale każda rozegrana gra pojawia się publicznie na czacie.\n\n' +
        `Saldo: ${formatCoins(state.balance)}\nStawka: ${formatCoins(state.bet)}`,
      )
      .setFooter({ text: `Stawki ${casino.MIN_BET}-${casino.MAX_BET}. Bob ostrzega: dom zawsze wygrywa.` });
  }
  if (state.notice) embed.setDescription(`${state.notice}\n\n${embed.data.description ?? ''}`.trim());

  const rows = [];

  // Rząd 1: wybór gry (zawsze widoczny = "Zmień grę")
  const gameRow = new ActionRowBuilder();
  for (const [key, game] of Object.entries(GAMES)) {
    gameRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`kas_game_${key}`)
        .setLabel(game.label)
        .setEmoji(game.emoji)
        .setStyle(state.view === 'game' && state.game === key ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(disabled),
    );
  }
  gameRow.addComponents(
    new ButtonBuilder()
      .setCustomId('kas_rules')
      .setLabel('Zasady')
      .setEmoji('📖')
      .setStyle(state.view === 'rules' ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(disabled),
  );
  rows.push(gameRow);

  if (state.view === 'game' && state.game) {
    // Rząd 2: wybór zakładu (zależny od gry)
    if (state.game === 'ruletka') {
      const select = new StringSelectMenuBuilder()
        .setCustomId('kas_roul_kind')
        .setPlaceholder('Na co stawiasz?')
        .setDisabled(disabled)
        .addOptions(
          Object.entries(casino.ROULETTE_BETS).map(([value, bet]) => ({
            label: value === 'numer' ? 'Konkretny numer (x36)' : `${bet.label} (x${bet.multiplier})`,
            value,
            default: value === state.rouletteKind,
          })),
        );
      rows.push(new ActionRowBuilder().addComponents(select));
    } else if (state.game === 'moneta') {
      rows.push(
        new ActionRowBuilder().addComponents(
          ...Object.entries(SIDE_LABELS).map(([side, label]) =>
            new ButtonBuilder()
              .setCustomId(`kas_side_${side}`)
              .setLabel(label.slice(2).trim())
              .setEmoji(label.slice(0, 2).trim())
              .setStyle(state.coinSide === side ? ButtonStyle.Success : ButtonStyle.Secondary)
              .setDisabled(disabled)),
        ),
      );
    }

    // Rząd 3: stawka (zawsze można zmienić) + numer ruletki
    const betRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('kas_bet_half').setLabel('½').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId('kas_bet_edit')
        .setLabel(`Stawka: ${state.bet.toLocaleString('pl-PL')}`)
        .setEmoji('✏️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
      new ButtonBuilder().setCustomId('kas_bet_double').setLabel('×2').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    );
    if (state.game === 'ruletka' && state.rouletteKind === 'numer') {
      betRow.addComponents(
        new ButtonBuilder()
          .setCustomId('kas_num_edit')
          .setLabel(`Numer: ${state.rouletteNumber}`)
          .setEmoji('🔢')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disabled),
      );
    }
    rows.push(betRow);

    // Rząd 4: zagraj / jeszcze raz
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('kas_play')
          .setLabel(state.played ? 'Jeszcze raz' : 'Zagraj')
          .setEmoji(state.played ? '🔁' : '▶️')
          .setStyle(ButtonStyle.Success)
          .setDisabled(disabled),
        new ButtonBuilder().setCustomId('kas_close').setLabel('Zamknij').setEmoji('✖️').setStyle(ButtonStyle.Danger).setDisabled(disabled),
      ),
    );
  }

  return { content: '', embeds: [embed], components: rows };
}

// ---------------- PUBLICZNA WIADOMOŚĆ Z GRĄ ----------------

// Gra ląduje na kanale jako zwykła wiadomość bota (widoczna dla wszystkich).
// Gdyby bot nie mógł pisać na kanale, próbujemy odpowiedzi przez interakcję.
// Zwraca { edit } albo null, jeśli nie udało się nic opublikować.
async function openPublic(click, payload) {
  try {
    const channel = click.channel ?? (await click.client.channels.fetch(click.channelId));
    const message = await channel.send(payload);
    return { edit: (p) => message.edit(p) };
  } catch {
    try {
      const message = await click.followUp(payload);
      return { edit: (p) => click.webhook.editMessage(message.id, p) };
    } catch {
      return null;
    }
  }
}

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

// Każda gra zwraca { balance, summary, shown } albo null, gdy saldo nie wystarcza na stawkę.
// shown = czy wynik poszedł publicznie na kanał (jeśli nie, pokażemy go w prywatnym menu).

async function playSlots(click, guildId, user, bet) {
  const spin = casino.spinSlots();
  const payout = Math.floor(bet * spin.multiplier);

  const balance = await casino.settleBet(guildId, user.id, bet, payout, 'casino_automat');
  if (balance === null) return null;

  const frame = (reels, footer) =>
    new EmbedBuilder().setColor(0x7a5420).setTitle('🎰 Automat Boba').setDescription(`# ${reels.join(' | ')}`).setFooter({ text: footer });

  const header = `${user} kręci automatem!`;
  const pub = await openPublic(click, { content: header, embeds: [frame(['❔', '❔', '❔'], `Stawka: ${bet}`)], allowedMentions: noPings });
  if (pub) {
    await sleep(900);
    await pub.edit({ embeds: [frame([spin.reels[0], '❔', '❔'], 'Bębny się kręcą...')] }).catch(() => null);
    await sleep(900);
    await pub.edit({ embeds: [frame([spin.reels[0], spin.reels[1], '❔'], 'Jeszcze jeden...')] }).catch(() => null);
    await sleep(1000);
  }

  const style = outcomeStyle(bet, payout);
  const label = spin.kind === 'triple' ? `Trzy takie same: x${spin.multiplier}` : spin.kind === 'pair' ? `Para: x${spin.multiplier}` : 'Brak układu';
  const embed = new EmbedBuilder()
    .setColor(style.color)
    .setTitle(`🎰 ${style.head}`)
    .setDescription(`# ${spin.reels.join(' | ')}\n${label}\n\n${resultLines(bet, payout, balance)}\n\n🥃 *Bob: ${style.quip}*`);
  if (pub) await pub.edit({ content: header, embeds: [embed], allowedMentions: noPings }).catch(() => null);

  return { balance, shown: Boolean(pub), summary: `🎰 ${spin.reels.join(' ')}: ${style.head} (stawka ${bet}, wypłata ${payout}, saldo ${balance})` };
}

async function playRoulette(click, guildId, user, bet, kind, chosenNumber) {
  const spin = casino.spinRoulette(kind, chosenNumber);
  const payout = bet * spin.multiplier;

  const balance = await casino.settleBet(guildId, user.id, bet, payout, 'casino_ruletka');
  if (balance === null) return null;

  const def = casino.ROULETTE_BETS[kind];
  const betLabel = kind === 'numer' ? `Numer ${chosenNumber} (x36)` : `${def.label} (x${def.multiplier})`;
  const header = `${user} stawia na: **${betLabel}**`;

  const pub = await openPublic(click, {
    content: header,
    embeds: [new EmbedBuilder().setColor(0x7a5420).setTitle('🎡 Ruletka').setDescription('Kula wiruje po kole... 🌀\n\n# ❔').setFooter({ text: `Stawka: ${bet}` })],
    allowedMentions: noPings,
  });
  if (pub) await sleep(2200);

  const style = outcomeStyle(bet, payout);
  const embed = new EmbedBuilder()
    .setColor(style.color)
    .setTitle(`🎡 ${style.head}`)
    .setDescription(
      `Kula zatrzymała się na:\n# ${spin.color} ${spin.number}\n\n${resultLines(bet, payout, balance)}\n\n` +
      `🥃 *Bob: ${spin.number === 0 ? 'Zero. Dom wygrywa. Zawsze wygrywa.' : style.quip}*`,
    );
  if (pub) await pub.edit({ content: header, embeds: [embed], allowedMentions: noPings }).catch(() => null);

  return { balance, shown: Boolean(pub), summary: `🎡 ${spin.color} ${spin.number}: ${style.head} (stawka ${bet}, wypłata ${payout}, saldo ${balance})` };
}

async function playCoin(click, guildId, user, bet, side) {
  const flip = casino.flipCoin(side);
  const payout = bet * flip.multiplier;

  const balance = await casino.settleBet(guildId, user.id, bet, payout, 'casino_moneta');
  if (balance === null) return null;

  const header = `${user} rzuca monetą i stawia na: **${SIDE_LABELS[side]}**`;
  const pub = await openPublic(click, {
    content: header,
    embeds: [new EmbedBuilder().setColor(0x7a5420).setTitle('🪙 Rzut monetą').setDescription('Moneta wirująca w powietrzu... 🌀\n\n# ❔').setFooter({ text: `Stawka: ${bet}` })],
    allowedMentions: noPings,
  });
  if (pub) await sleep(1600);

  const style = outcomeStyle(bet, payout);
  const embed = new EmbedBuilder()
    .setColor(style.color)
    .setTitle(`🪙 ${style.head}`)
    .setDescription(`Wypadło:\n# ${SIDE_LABELS[flip.result]}\n\n${resultLines(bet, payout, balance)}\n\n🥃 *Bob: ${style.quip}*`);
  if (pub) await pub.edit({ content: header, embeds: [embed], allowedMentions: noPings }).catch(() => null);

  return { balance, shown: Boolean(pub), summary: `🪙 ${SIDE_LABELS[flip.result]}: ${style.head} (stawka ${bet}, wypłata ${payout}, saldo ${balance})` };
}

// ---------------- OBSŁUGA KLIKNIĘĆ ----------------

// Pytanie o liczbę w okienku (modal): stawka albo numer ruletki.
async function askNumber(click, session, { key, title, label, min, max, apply }) {
  const customId = `kas_modal_${key}_${click.id}`;
  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('value').setLabel(label).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(12),
      ),
    );
  await click.showModal(modal);

  let submit;
  try {
    submit = await click.awaitModalSubmit({
      filter: (i) => i.customId === customId && i.user.id === session.user.id,
      time: 60_000,
    });
  } catch {
    return; // okienko zamknięte bez wysłania: nic się nie zmienia
  }

  const raw = submit.fields.getTextInputValue('value').replace(/[\s,._]/g, '');
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) {
    await submit.reply({ content: `⚠️ Podaj liczbę całkowitą od ${min} do ${max}.`, flags: MessageFlags.Ephemeral });
    return;
  }

  apply(n);
  session.state.notice = null;
  await submit.update(await buildPanel(session));
}

async function handlePlay(click, session) {
  const { state, guildId, user } = session;

  const start = casino.tryStartGame(guildId, user.id);
  if (!start.ok) {
    await click.reply({ content: start.message, flags: MessageFlags.Ephemeral });
    return;
  }

  state.busy = true;
  try {
    // Natychmiast wyłączamy przyciski, żeby nie dało się kliknąć drugi raz w trakcie gry
    await click.update(await buildPanel(session, { disabled: true }));

    let result;
    if (state.game === 'automat') result = await playSlots(click, guildId, user, state.bet);
    else if (state.game === 'ruletka') result = await playRoulette(click, guildId, user, state.bet, state.rouletteKind, state.rouletteNumber);
    else result = await playCoin(click, guildId, user, state.bet, state.coinSide);

    if (result === null) {
      state.balance = null; // odświeżymy z bazy
      state.notice = `💸 Nie stać Cię na stawkę ${formatCoins(state.bet)}. Zmień stawkę albo odbierz \`/nagroda\`.`;
    } else {
      state.balance = result.balance;
      state.played = true;
      state.notice = result.shown ? null : `⚠️ Nie mogę pisać na tym kanale, więc wynik widzisz tylko tutaj:\n${result.summary}`;
    }
  } finally {
    casino.finishGame(guildId, user.id);
    state.busy = false;
  }

  await click.editReply(await buildPanel(session)).catch((err) => console.error('Kasyno: nie odświeżono menu:', err.message));
}

async function onClick(click, session) {
  const { state } = session;
  const id = click.customId;

  // Kliknięcia w trakcie trwającej gry ignorujemy (przyciski i tak są wtedy wyłączone)
  if (state.busy) {
    await click.deferUpdate().catch(() => null);
    return;
  }

  const refresh = async () => {
    state.notice = null;
    await click.update(await buildPanel(session));
  };

  if (id.startsWith('kas_game_')) {
    const game = id.slice('kas_game_'.length);
    if (!GAMES[game]) return;
    state.game = game;
    state.view = 'game';
    state.played = false;
    return refresh();
  }
  if (id === 'kas_rules') {
    state.view = 'rules';
    return refresh();
  }
  if (id === 'kas_roul_kind') {
    const value = click.values?.[0];
    if (!casino.ROULETTE_BETS[value]) return;
    state.rouletteKind = value;
    state.played = false;
    return refresh();
  }
  if (id.startsWith('kas_side_')) {
    const side = id.slice('kas_side_'.length);
    if (!SIDE_LABELS[side]) return;
    state.coinSide = side;
    state.played = false;
    return refresh();
  }
  if (id === 'kas_bet_half') {
    state.bet = Math.max(casino.MIN_BET, Math.floor(state.bet / 2));
    return refresh();
  }
  if (id === 'kas_bet_double') {
    state.bet = Math.min(casino.MAX_BET, state.bet * 2);
    return refresh();
  }
  if (id === 'kas_bet_edit') {
    return askNumber(click, session, {
      key: 'bet',
      title: 'Twoja stawka',
      label: `Stawka (${casino.MIN_BET}-${casino.MAX_BET})`,
      min: casino.MIN_BET,
      max: casino.MAX_BET,
      apply: (n) => { state.bet = n; },
    });
  }
  if (id === 'kas_num_edit') {
    return askNumber(click, session, {
      key: 'num',
      title: 'Numer w ruletce',
      label: 'Numer (0-36)',
      min: 0,
      max: 36,
      apply: (n) => { state.rouletteNumber = n; },
    });
  }
  if (id === 'kas_play') {
    if (state.view !== 'game' || !state.game) return refresh();
    return handlePlay(click, session);
  }
  if (id === 'kas_close') {
    session.closed = true;
    session.collector?.stop('closed');
    await click.update({ content: '🎲 Menu kasyna zamknięte. Wpisz `/kasyno`, żeby wrócić.', embeds: [], components: [] });
  }
}

function newSession(interaction) {
  return {
    interaction,
    guildId: interaction.guild.id,
    user: interaction.user,
    closed: false,
    collector: null,
    state: {
      view: 'home', // home | game | rules
      game: null,
      bet: DEFAULT_BET,
      rouletteKind: 'czerwone',
      rouletteNumber: 17,
      coinSide: 'orzel',
      played: false,
      busy: false,
      balance: null,
      notice: null,
    },
  };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('kasyno')
    .setDescription('Kasyno Boba: automat, ruletka i orzeł/reszka. Menu jest prywatne, a gra publiczna.')
    .setDMPermission(false),

  async execute(interaction) {
    if (!interaction.guild) {
      await interaction.reply({ content: 'Kasyno działa tylko na serwerze.', flags: MessageFlags.Ephemeral });
      return;
    }

    const session = newSession(interaction);
    await interaction.reply({ ...(await buildPanel(session)), flags: MessageFlags.Ephemeral });
    const message = await interaction.fetchReply();

    const collector = message.createMessageComponentCollector({
      filter: (i) => i.user.id === interaction.user.id,
      idle: MENU_IDLE_MS,
      time: MENU_MAX_MS,
    });
    session.collector = collector;

    collector.on('collect', (click) => {
      onClick(click, session).catch(async (err) => {
        console.error('Kasyno: błąd obsługi kliknięcia:', err);
        const payload = { content: '❌ Coś poszło nie tak w kasynie. Spróbuj ponownie.', flags: MessageFlags.Ephemeral };
        if (click.replied || click.deferred) await click.followUp(payload).catch(() => null);
        else await click.reply(payload).catch(() => null);
      });
    });

    collector.on('end', async (_collected, reason) => {
      if (reason === 'closed') return;
      await interaction
        .editReply({ content: '⌛ Menu kasyna wygasło. Wpisz `/kasyno`, żeby otworzyć je ponownie.', embeds: [], components: [] })
        .catch(() => null);
    });
  },

  // Eksport do testów
  _test: { buildPanel, onClick, newSession, GAMES },
};
