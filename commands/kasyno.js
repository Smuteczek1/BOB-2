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
const bj = require('../utils/blackjack');

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
  blackjack: { label: 'Blackjack', emoji: '🃏', blurb: 'Zbierz bliżej 21 niż krupier, ale nie więcej. Dobierasz, pasujesz albo podwajasz. Blackjack płaci 3:2.' },
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
// Zwrot przy poprawnej strategii podstawowej, policzony symulacją (utils/blackjack.js: simulateRtp). Zmieniłeś zasady? Przelicz i popraw.
const BJ_RTP_TEXT = '99%';

// ---------------- BLACKJACK: WIDOK ----------------

const fmtCards = (cards) => cards.map((c) => `\`${c.rank}${c.suit}\``).join(' ');
const fmtTotal = (cards) => {
  const { total, soft } = bj.handValue(cards);
  return `${total}${soft && total <= 21 ? ' (miękkie)' : ''}`;
};

const BJ_RESULT = {
  blackjack: '🃏 BLACKJACK!',
  win: '✅ Wygrana!',
  push: '🤝 Remis',
  lose: '❌ Przegrana',
  bust: '💥 Powyżej 21',
  dealer_blackjack: '❌ Krupier ma blackjacka',
};

// Stół widoczny publicznie. Dopóki gra trwa, druga karta krupiera jest zakryta.
function bjTable(game, bet, { reveal = false } = {}) {
  const dealer = reveal ? `${fmtCards(game.dealer)} = **${fmtTotal(game.dealer)}**` : `${fmtCards([game.dealer[0]])} \`❔\``;
  const stake = bj.stakeFor(bet, game);
  return (
    `**Krupier:** ${dealer}\n` +
    `**Gracz:** ${fmtCards(game.player)} = **${fmtTotal(game.player)}**\n\n` +
    `Stawka: ${formatCoins(stake)}${game.doubled ? ' (podwojona)' : ''}`
  );
}

function bjPlayingEmbed(game, bet) {
  return new EmbedBuilder()
    .setColor(0x7a5420)
    .setTitle('🃏 Blackjack')
    .setDescription(bjTable(game, bet))
    .setFooter({ text: 'Gracz decyduje: dobierz, pasuj albo podwój.' });
}


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
      {
        name: `🃏 Blackjack (zwrot ok. ${BJ_RTP_TEXT})`,
        value:
          'Wygrana **x2**, blackjack (As + 10/figura) **x2.5**, remis zwraca stawkę.\n' +
          `Krupier staje na 17, ${bj.DECKS} talii, tasowane co rozdanie.\n` +
          'Podwojenie na pierwszych dwóch kartach (stawka x2, jedna karta). Bez dzielenia par.\n' +
          'Gdy zamkniesz menu w trakcie rozdania, pasujesz automatycznie.',
        inline: false,
      },
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

  // Trwa rozdanie blackjacka: pokazujemy tylko jego przyciski (nie da się zmienić gry ani stawki)
  if (state.bj) {
    const { game, bet } = state.bj;
    const canDbl = bj.canDouble(game) && state.balance >= bet;
    const embed = new EmbedBuilder()
      .setColor(0x7a5420)
      .setTitle('🃏 Blackjack: Twój ruch')
      .setDescription(
        `${state.notice ? `${state.notice}\n\n` : ''}${bjTable(game, bet)}\nSaldo: ${formatCoins(state.balance)}`,
      )
      .setFooter({ text: 'To menu widzisz tylko Ty. Stół jest publicznie na czacie.' });
    return {
      content: '',
      embeds: [embed],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('kas_bj_hit').setLabel('Dobierz').setEmoji('➕').setStyle(ButtonStyle.Primary).setDisabled(disabled),
          new ButtonBuilder().setCustomId('kas_bj_stand').setLabel('Pasuję').setEmoji('✋').setStyle(ButtonStyle.Success).setDisabled(disabled),
          new ButtonBuilder()
            .setCustomId('kas_bj_double')
            .setLabel('Podwój')
            .setEmoji('✖️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled || !canDbl),
        ),
      ],
    };
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
// Ponawia operację z narastającą przerwą (przy przeciążeniu Discorda: timeouty, 5xx, 429).
async function withRetry(fn, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < tries - 1) await sleep(500 * 2 ** i); // 0,5 s, 1 s, 2 s
    }
  }
  throw lastErr;
}

async function openPublic(click, payload) {
  try {
    const channel = click.channel ?? (await click.client.channels.fetch(click.channelId));
    const message = await withRetry(() => channel.send(payload), 3);
    return { edit: (p) => message.edit(p), send: (p) => channel.send(p), remove: () => message.delete() };
  } catch {
    try {
      const message = await withRetry(() => click.followUp(payload), 3);
      return {
        edit: (p) => click.webhook.editMessage(message.id, p),
        send: (p) => click.followUp(p),
        remove: () => click.webhook.deleteMessage(message.id),
      };
    } catch {
      return null;
    }
  }
}

// Klatka animacji: ozdoba. Jedna próba, błąd tylko logujemy (nie spowalnia gry).
async function animate(pub, payload) {
  if (!pub) return;
  await pub.edit(payload).catch((err) => console.error('Kasyno: klatka animacji nie przeszła:', err.message));
}

async function getCasinoLogChannel({ client, guildId }) {
  try {
    const config = await db.getGuildConfig(guildId);
    if (!config?.casino_log_channel_id) return null;
    const channel = await client.channels.fetch(config.casino_log_channel_id);
    return channel?.isTextBased?.() ? channel : null;
  } catch (err) {
    console.error('Kasyno: nie udało się pobrać kanału wyników:', err.message);
    return null;
  }
}

// Co pokazać w prywatnym menu po grze: gdy wynik poszedł na kanał wyników, gracz dostaje skrót i link
const resultNotice = (shown, summary) => {
  if (shown?.archivedTo) return `📜 Wynik trafił na <#${shown.archivedTo}>:\n${summary}`;
  if (shown) return null;
  return `⚠️ Nie udało się pokazać wyniku na kanale (brak uprawnień albo Discord jest przeciążony). Gra jest rozliczona, wynik:\n${summary}`;
};

// Wynik końcowy: pieniądze są już rozliczone w bazie, więc wynik MUSI dotrzeć do gracza.
// 1) edycja wiadomości z grą (z ponowieniami), 2) nowa wiadomość z wynikiem, 3) false -> wynik pokaże prywatne menu.
// Gdy serwer ma ustawiony kanał wyników (/setup-kasyno), wynik idzie TAM, a wiadomość z gry znika z kanału, na którym grano.
// Wtedy zwraca { archivedTo: channelId }. Gdy kanału brak albo wysyłka się nie uda, zostaje zwykłe zachowanie (wynik w miejscu gry).
// archive = { client, guildId, channelId } (channelId = kanał, na którym grano)
async function deliverFinal(pub, payload, archive) {
  if (!pub) return false;

  const logChannel = archive ? await getCasinoLogChannel(archive) : null;
  if (logChannel) {
    try {
      const where = archive.channelId ? ` · <#${archive.channelId}>` : '';
      await withRetry(() => logChannel.send({ ...payload, content: `${payload.content ?? ''}${where}`, allowedMentions: noPings }));
      // Wynik już jest na kanale wyników. Wiadomość z gry usuwamy; jeśli się nie da, zostawiamy w niej wynik zamiast zawieszonej animacji.
      await Promise.resolve(pub.remove?.()).catch(async (err) => {
        console.error('Kasyno: nie usunięto wiadomości z gry:', err.message);
        await pub.edit(payload).catch(() => null);
      });
      return { archivedTo: logChannel.id };
    } catch (err) {
      console.error('Kasyno: nie udało się wysłać wyniku na kanał wyników, zostaje w miejscu gry:', err.message);
    }
  }

  try {
    await withRetry(() => pub.edit(payload));
    return true;
  } catch (err) {
    console.error('Kasyno: nie udało się edytować wyniku, wysyłam nową wiadomość:', err.message);
  }
  try {
    await withRetry(() => pub.send(payload));
    return true;
  } catch (err) {
    console.error('Kasyno: nie udało się dostarczyć wyniku:', err.message);
    return false;
  }
}

function outcomeStyle(bet, payout) {
  if (payout > bet * 20) return { color: 0xf1c40f, head: '💰 JACKPOT!', quip: pick(BOB_BIG_WIN) };
  if (payout > bet) return { color: 0x2ecc71, head: '✅ Wygrana!', quip: pick(BOB_WIN) };
  if (payout === bet) return { color: 0x95a5a6, head: '🤝 Zwrot stawki', quip: pick(BOB_PUSH) };
  if (payout > 0) return { color: 0xe67e22, head: '🟠 Częściowy zwrot', quip: pick(BOB_PUSH) };
  return { color: 0xe74c3c, head: '❌ Przegrana', quip: pick(BOB_LOSE) };
}

function insuranceLine(ins) {
  if (!ins) return '';
  if (ins.refund > 0) {
    return `\n🛡️ **${ins.name}** uratowała Ci ${formatCoins(ins.refund)}!` + (ins.bonusTicket ? '\n🎁 **Bonus!** Darmowy los trafił do ekwipunku.' : '');
  }
  if (ins.usedOnWin) return `\n🛡️ ${ins.name} nie była potrzebna (wygrana) i została zużyta.`;
  return `\n🛡️ ${ins.name} nie zadziałała (szansa ${ins.chance}%).`;
}

function resultLines(bet, payout, balance, insurance = null) {
  const net = payout - bet;
  const netText = net > 0 ? `+${formatCoins(net)}` : net < 0 ? `−${formatCoins(-net)}` : 'bez zmian';
  return `Stawka: ${formatCoins(bet)}\nWynik: ${netText}\nSaldo: ${formatCoins(balance)}${insuranceLine(insurance)}`;
}

// Każda gra zwraca { balance, summary, shown } albo null, gdy saldo nie wystarcza na stawkę.
// shown = czy wynik poszedł publicznie na kanał (jeśli nie, pokażemy go w prywatnym menu).

async function playSlots(click, guildId, user, bet) {
  const spin = casino.spinSlots();
  const basePayout = Math.floor(bet * spin.multiplier);

  const settled = await casino.settleBetEx(guildId, user.id, bet, basePayout, 'casino_automat');
  if (settled === null) return null;
  const { balance, payout, insurance } = settled;

  const frame = (reels, footer) =>
    new EmbedBuilder().setColor(0x7a5420).setTitle('🎰 Automat Boba').setDescription(`# ${reels.join(' | ')}`).setFooter({ text: footer });

  const header = `${user} kręci automatem!`;
  const pub = await openPublic(click, { content: header, embeds: [frame(['❔', '❔', '❔'], `Stawka: ${bet}`)], allowedMentions: noPings });
  if (pub) {
    await sleep(900);
    await animate(pub, { embeds: [frame([spin.reels[0], '❔', '❔'], 'Bębny się kręcą...')] });
    await sleep(900);
    await animate(pub, { embeds: [frame([spin.reels[0], spin.reels[1], '❔'], 'Jeszcze jeden...')] });
    await sleep(1000);
  }

  const style = outcomeStyle(bet, payout);
  const label = spin.kind === 'triple' ? `Trzy takie same: x${spin.multiplier}` : spin.kind === 'pair' ? `Para: x${spin.multiplier}` : 'Brak układu';
  const embed = new EmbedBuilder()
    .setColor(style.color)
    .setTitle(`🎰 ${style.head}`)
    .setDescription(`# ${spin.reels.join(' | ')}\n${label}\n\n${resultLines(bet, payout, balance, insurance)}\n\n🥃 *Bob: ${style.quip}*`);
  const shown = await deliverFinal(pub, { content: header, embeds: [embed], allowedMentions: noPings }, { client: click.client, guildId, channelId: click.channelId });

  return { balance, shown, summary: `🎰 ${spin.reels.join(' ')}: ${style.head} (stawka ${bet}, wypłata ${payout}, saldo ${balance})` };
}

async function playRoulette(click, guildId, user, bet, kind, chosenNumber) {
  const spin = casino.spinRoulette(kind, chosenNumber);
  const basePayout = bet * spin.multiplier;

  const settled = await casino.settleBetEx(guildId, user.id, bet, basePayout, 'casino_ruletka');
  if (settled === null) return null;
  const { balance, payout, insurance } = settled;

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
      `Kula zatrzymała się na:\n# ${spin.color} ${spin.number}\n\n${resultLines(bet, payout, balance, insurance)}\n\n` +
      `🥃 *Bob: ${spin.number === 0 ? 'Zero. Dom wygrywa. Zawsze wygrywa.' : style.quip}*`,
    );
  const shown = await deliverFinal(pub, { content: header, embeds: [embed], allowedMentions: noPings }, { client: click.client, guildId, channelId: click.channelId });

  return { balance, shown, summary: `🎡 ${spin.color} ${spin.number}: ${style.head} (stawka ${bet}, wypłata ${payout}, saldo ${balance})` };
}

async function playCoin(click, guildId, user, bet, side) {
  const flip = casino.flipCoin(side);
  const basePayout = bet * flip.multiplier;

  const settled = await casino.settleBetEx(guildId, user.id, bet, basePayout, 'casino_moneta');
  if (settled === null) return null;
  const { balance, payout, insurance } = settled;

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
    .setDescription(`Wypadło:\n# ${SIDE_LABELS[flip.result]}\n\n${resultLines(bet, payout, balance, insurance)}\n\n🥃 *Bob: ${style.quip}*`);
  const shown = await deliverFinal(pub, { content: header, embeds: [embed], allowedMentions: noPings }, { client: click.client, guildId, channelId: click.channelId });

  return { balance, shown, summary: `🪙 ${SIDE_LABELS[flip.result]}: ${style.head} (stawka ${bet}, wypłata ${payout}, saldo ${balance})` };
}

// ---------------- BLACKJACK: ROZGRYWKA ----------------
// Stawka jest pobierana z góry (holdStake), więc w trakcie rozdania nie da się jej wydać gdzie indziej.
// Rozdanie żyje w session.state.bj = { game, bet, held, pub, header } i kończy się w bjFinish.

// Kończy rozdanie: rozlicza pieniądze (jedna transakcja), pokazuje wynik publicznie, zwalnia blokadę gry.
async function bjFinish(session) {
  const { state, guildId, user } = session;
  const { game, bet, held, pub, header } = state.bj;
  const stake = bj.stakeFor(bet, game);
  const basePayout = bj.payoutFor(bet, game);

  let settled;
  try {
    settled = await casino.settleBetEx(guildId, user.id, stake, basePayout, game.doubled ? 'casino_blackjack_x2' : 'casino_blackjack', held);
  } finally {
    state.bj = null;
    casino.finishGame(guildId, user.id);
  }
  if (settled === null) throw new Error('bjFinish: rozliczenie zwróciło null mimo pobranej stawki');
  const { balance, payout, insurance } = settled;

  const style = outcomeStyle(stake, payout);
  const embed = new EmbedBuilder()
    .setColor(style.color)
    .setTitle(`🃏 ${BJ_RESULT[game.outcome]}`)
    .setDescription(
      `**Krupier:** ${fmtCards(game.dealer)} = **${fmtTotal(game.dealer)}**\n` +
      `**Gracz:** ${fmtCards(game.player)} = **${fmtTotal(game.player)}**\n\n` +
      `${resultLines(stake, payout, balance, insurance)}\n\n🥃 *Bob: ${style.quip}*`,
    );
  const shown = await deliverFinal(pub, { content: header, embeds: [embed], allowedMentions: noPings }, {
    client: session.interaction.client,
    guildId,
    channelId: session.interaction.channelId,
  });

  state.balance = balance;
  state.played = true;
  state.notice = resultNotice(shown, `🃏 ${BJ_RESULT[game.outcome]} (stawka ${stake}, wypłata ${payout}, saldo ${balance})`);
}

async function bjStart(click, session) {
  const { state, guildId, user } = session;

  const start = casino.tryStartGame(guildId, user.id);
  if (!start.ok) {
    await click.reply({ content: start.message, flags: MessageFlags.Ephemeral });
    return;
  }

  state.busy = true;
  try {
    await click.deferUpdate();
    await bjDeal(click, session);
  } catch (err) {
    console.error('Kasyno: błąd startu blackjacka:', err);
    state.notice = '❌ Coś poszło nie tak przy rozdaniu. Spróbuj ponownie.';
  } finally {
    state.busy = false;
    if (!state.bj) casino.finishGame(guildId, user.id); // blokada zostaje tylko na czas trwającego rozdania
  }

  await click.editReply(await buildPanel(session)).catch((err) => console.error('Kasyno: nie odświeżono menu:', err.message));
}

// Pobiera stawkę, rozdaje karty i publikuje stół. Ustawia state.bj, jeśli rozdanie trwa dalej.
async function bjDeal(click, session) {
  const { state, guildId, user } = session;
  const bet = state.bet;

  const balance = await casino.holdStake(guildId, user.id, bet, 'casino_blackjack_stawka');
  if (balance === null) {
    state.balance = null;
    state.notice = `💸 Nie stać Cię na stawkę ${formatCoins(bet)}. Zmień stawkę albo odbierz \`/nagroda\`.`;
    return;
  }

  try {
    const game = bj.startHand();
    const header = `${user} gra w blackjacka!`;
    const pub = await openPublic(click, { content: header, embeds: [bjPlayingEmbed(game, bet)], allowedMentions: noPings });
    state.bj = { game, bet, held: bet, pub, header };
    state.notice = null;

    if (game.outcome !== null) {
      // Blackjack albo blackjack krupiera na starcie: od razu rozliczamy
      if (pub) await sleep(900);
      await bjFinish(session);
    }
  } catch (err) {
    if (state.bj) {
      // Stawka pobrana, a coś się wysypało: kończymy rozdanie pasując, żeby gracz dostał rozliczenie
      console.error('Kasyno: błąd w trakcie rozdania, pasuję za gracza:', err);
      await bjAutoStand(session);
    } else {
      // Nie doszło do rozdania: oddajemy stawkę
      await casino.settleBetEx(guildId, user.id, bet, bet, 'casino_blackjack_zwrot', bet);
      throw err;
    }
  }
}

// action: 'hit' | 'stand' | 'double'
async function bjAction(click, session, action) {
  const { state } = session;
  if (!state.bj) return click.deferUpdate().catch(() => null);

  state.busy = true;
  try {
    await click.deferUpdate();
    await bjStep(session, action);
  } catch (err) {
    console.error('Kasyno: błąd w trakcie blackjacka:', err);
    state.notice = '❌ Coś poszło nie tak. Spróbuj jeszcze raz.';
  } finally {
    state.busy = false;
  }

  await click.editReply(await buildPanel(session)).catch((err) => console.error('Kasyno: nie odświeżono menu:', err.message));
}

async function bjStep(session, action) {
  const { state, guildId, user } = session;
  const hand = state.bj;
  const { game, bet } = hand;

  if (action === 'double') {
    if (!bj.canDouble(game)) {
      state.notice = '⚠️ Podwoić można tylko na pierwszych dwóch kartach.';
      return;
    }
    const extra = await casino.holdStake(guildId, user.id, bet, 'casino_blackjack_podwojenie');
    if (extra === null) {
      state.balance = null;
      state.notice = `💸 Nie stać Cię na podwojenie (potrzeba jeszcze ${formatCoins(bet)}).`;
      return;
    }
    hand.held += bet;
    bj.double(game);
  } else if (action === 'hit') {
    bj.hit(game);
  } else {
    bj.stand(game);
  }
  state.notice = null;

  if (game.outcome !== null) await bjFinish(session);
  else await animate(hand.pub, { content: hand.header, embeds: [bjPlayingEmbed(game, bet)], allowedMentions: noPings });
}

// Menu wygasło albo się zamknęło w trakcie rozdania: pasujemy za gracza, żeby nie przepadła stawka
async function bjAutoStand(session) {
  if (!session.state.bj) return;
  try {
    if (session.state.bj.game.outcome === null) bj.stand(session.state.bj.game);
    await bjFinish(session);
  } catch (err) {
    console.error('Kasyno: nie udało się dokończyć rozdania blackjacka:', err);
  }
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
      state.notice = resultNotice(result.shown, result.summary);
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

  // W trakcie rozdania blackjacka działają tylko jego przyciski
  if (state.bj) {
    if (id === 'kas_bj_hit') return bjAction(click, session, 'hit');
    if (id === 'kas_bj_stand') return bjAction(click, session, 'stand');
    if (id === 'kas_bj_double') return bjAction(click, session, 'double');
    await click.deferUpdate().catch(() => null);
    return;
  }

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
    if (state.game === 'blackjack') return bjStart(click, session);
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
      bj: null, // trwające rozdanie blackjacka
      busy: false,
      balance: null,
      notice: null,
    },
  };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('kasyno')
    .setDescription('Kasyno Boba: automat, ruletka, orzeł/reszka i blackjack. Menu jest prywatne, a gra publiczna.')
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
      await bjAutoStand(session); // niedokończone rozdanie blackjacka kończy się pasowaniem
      if (reason === 'closed') return;
      await interaction
        .editReply({ content: '⌛ Menu kasyna wygasło. Wpisz `/kasyno`, żeby otworzyć je ponownie.', embeds: [], components: [] })
        .catch(() => null);
    });
  },

  // Eksport do testów
  _test: { buildPanel, onClick, newSession, GAMES, bjAutoStand },
};
