const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  MessageFlags,
} = require('discord.js');
const { formatCoins } = require('../utils/economy');
const lotto = require('../utils/lotto');

// ============================================================
//  /lotto: PRYWATNE menu (widzisz je tylko Ty), zbudowane z Components V2 tak jak sklep.
//  Otwiera się komendą /lotto ALBO przyciskiem "Kup los" pod ogłoszeniem na kanale lotto.
//  Losowanie i wyniki są publiczne na kanale ustawionym przez /setup-lotto.
// ============================================================

const V2 = MessageFlags.IsComponentsV2;
const MENU_IDLE_MS = 5 * 60 * 1000;
const MENU_MAX_MS = 14 * 60 * 1000;

const { PICK, RANGE, PRICE, MAX_TICKETS } = lotto;

const text = (s) => new TextDisplayBuilder().setContent(s);
const sep = (big = false) => new SeparatorBuilder().setSpacing(big ? SeparatorSpacingSize.Large : SeparatorSpacingSize.Small);
const pct = (p) => `${(p * 100).toFixed(p < 0.01 ? 2 : 1).replace('.', ',')}%`;
const pad = (n) => String(n).padStart(2, '0');

// Discord pozwala na max 25 pozycji w jednej liście rozwijanej, więc przy większym zakresie liczb
// dzielimy je na kilka list o podobnej długości.
const CHUNKS = (() => {
  const count = Math.ceil(RANGE / 25);
  const size = Math.ceil(RANGE / count);
  return Array.from({ length: count }, (_, i) => ({ index: i, from: i * size + 1, to: Math.min(RANGE, (i + 1) * size) }));
})();

function prizeBlock() {
  const lines = [
    `🏆 **${PICK} z ${PICK}** → **cała kumulacja** · szansa **${pct(lotto.oddsFor(PICK))}** _(1 na ${lotto.COMBINATIONS})_`,
  ];
  for (let m = PICK - 1; m >= PICK - 2; m--) {
    const prize = lotto.prizeFor(m);
    lines.push(`${m === PICK - 1 ? '🥈' : '🥉'} **${m} z ${PICK}** → ${formatCoins(prize)}${prize === PRICE ? ' _(zwrot losu)_' : ''} · szansa **${pct(lotto.oddsFor(m))}**`);
  }
  lines.push(`🎯 Jakąkolwiek nagrodę dostajesz z szansą **${pct(lotto.anyPrizeOdds())}** na każdy los`);
  return lines.join('\n');
}

// Wybrane liczby jako "kulki": wypełnione i puste miejsca, żeby było widać, ile jeszcze brakuje
function selectedLine(selected) {
  if (selected.length === 0) return `Wybierz **${PICK}** liczby z list poniżej albo kliknij 🎲 **Losowe liczby**.`;
  const filled = selected.map((n) => `🟡 **${pad(n)}**`);
  const empty = Array.from({ length: Math.max(0, PICK - selected.length) }, () => '⚪ **--**');
  const tail = selected.length > PICK ? `  _(za dużo, odznacz ${selected.length - PICK})_` : selected.length < PICK ? `  _(jeszcze ${PICK - selected.length})_` : '  ✅ gotowe!';
  return `${[...filled, ...empty].join('   ')}${tail}`;
}

async function buildPanel(session, { disabled = false } = {}) {
  const { state } = session;
  const status = await lotto.getStatus(session.guildId, session.user.id);
  state.status = status;

  const atLimit = status.tickets.length >= MAX_TICKETS;
  const ready = state.selected.length === PICK;
  const drawTs = Math.floor(status.drawAt / 1000);

  const box = new ContainerBuilder().setAccentColor(0x3498db);

  if (state.notice) {
    box.addTextDisplayComponents(text(state.notice));
    box.addSeparatorComponents(sep());
  }

  box.addTextDisplayComponents(
    text(
      `## 🎱 Lotto Boba\n### Kumulacja\n# ${status.pool.toLocaleString('pl-PL')} 🪙\n` +
      `⏰ Losowanie: <t:${drawTs}:F> (<t:${drawTs}:R>)`,
    ),
  );
  box.addSeparatorComponents(sep());

  const ticketList = status.tickets.length
    ? status.tickets.map((t, i) => `**${i + 1}.** ${t.numbers.map((n) => `🟡 **${pad(n)}**`).join('  ')}`).join('\n')
    : '_Nie masz jeszcze losów na to losowanie._';
  box.addTextDisplayComponents(text(`### 🎟️ Twoje losy (${status.tickets.length}/${MAX_TICKETS})\n${ticketList}`));
  box.addSeparatorComponents(sep());

  box.addTextDisplayComponents(
    text(
      `### ✏️ Twój nowy los\n${selectedLine(state.selected)}\n` +
      `-# Cena: ${formatCoins(PRICE)} · Saldo: ${formatCoins(status.balance)}` +
      (atLimit ? '\n-# 🚫 Masz już komplet losów na to losowanie.' : ''),
    ),
  );

  // Jedna lista, gdy wszystkie liczby się mieszczą (wtedy Discord pilnuje dokładnie PICK wyborów);
  // inaczej kilka list, z których wybierasz łącznie PICK liczb.
  for (const chunk of CHUNKS) {
    const size = chunk.to - chunk.from + 1;
    const single = CHUNKS.length === 1;
    box.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`lotto_pick_${chunk.index}`)
          .setPlaceholder(single ? `Wybierz ${PICK} liczby (1-${RANGE})` : `Liczby ${chunk.from}-${chunk.to}`)
          .setMinValues(single ? PICK : 0)
          .setMaxValues(Math.min(PICK, size))
          .setDisabled(disabled || atLimit)
          .addOptions(
            Array.from({ length: size }, (_, i) => ({
              label: String(chunk.from + i),
              value: String(chunk.from + i),
              default: state.selected.includes(chunk.from + i),
            })),
          ),
      ),
    );
  }

  box.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('lotto_buy').setLabel(`Kup los (${PRICE})`).setEmoji('🎟️').setStyle(ButtonStyle.Success).setDisabled(disabled || atLimit || !ready),
      new ButtonBuilder().setCustomId('lotto_random').setLabel('Losowe liczby').setEmoji('🎲').setStyle(ButtonStyle.Secondary).setDisabled(disabled || atLimit),
      new ButtonBuilder().setCustomId('lotto_quick').setLabel('Kup losowy los').setEmoji('⚡').setStyle(ButtonStyle.Primary).setDisabled(disabled || atLimit),
      new ButtonBuilder().setCustomId('lotto_close').setLabel('Zamknij').setEmoji('✖️').setStyle(ButtonStyle.Danger).setDisabled(disabled),
    ),
  );

  box.addSeparatorComponents(sep());
  box.addTextDisplayComponents(text(`### 🏆 Nagrody i szanse\n${prizeBlock()}\n-# Jeśli nikt nie trafi ${PICK} z ${PICK}, pula rośnie dalej. Po wygranej startuje nowa, losowa kumulacja. Wyniki ogłasza Bob na kanale lotto.`));

  return { components: [box], flags: V2 };
}

// Mała wiadomość V2 (zamknięcie / wygaśnięcie menu): wiadomość V2 nie może zostać bez komponentów
const farewell = (msg) => ({ components: [new ContainerBuilder().setAccentColor(0x95a5a6).addTextDisplayComponents(text(msg))], flags: V2 });

const BUY_ERRORS = {
  funds: `💸 Nie stać Cię na los (${PRICE} monet). Odbierz \`/nagroda\`.`,
  limit: `🚫 Masz już maksymalną liczbę losów na to losowanie (${MAX_TICKETS}).`,
  invalid: '⚠️ Wybierz poprawne liczby.',
};

const boughtText = (result) =>
  `✅ **Kupiono los** 🟡 ${result.numbers.map(pad).join(' · ')}\n` +
  `Losowanie <t:${Math.floor(lotto.drawTimestamp(result.drawDate) / 1000)}:R> · kumulacja: **${result.pool.toLocaleString('pl-PL')} 🪙** · powodzenia! 🍀`;

async function buy(click, session, numbers) {
  const { state } = session;
  const result = await lotto.buyTicket(session.guildId, session.user.id, numbers);

  if (!result.ok) {
    state.notice = BUY_ERRORS[result.reason] ?? '❌ Nie udało się kupić losu.';
  } else {
    state.selected = [];
    state.notice = boughtText(result);
  }
  await click.update(await buildPanel(session));
}

async function onClick(click, session) {
  const { state } = session;
  const id = click.customId;

  if (id.startsWith('lotto_pick_')) {
    const chunk = CHUNKS[Number(id.slice('lotto_pick_'.length))];
    if (!chunk) return click.deferUpdate();
    // Każda lista odpowiada za swój zakres: liczby z drugiej listy zostają, ta nadpisuje tylko swój kawałek.
    const outside = state.selected.filter((n) => n < chunk.from || n > chunk.to);
    const inside = click.values.map(Number).filter((n) => Number.isInteger(n) && n >= chunk.from && n <= chunk.to);
    state.selected = [...outside, ...inside].sort((a, b) => a - b);
    state.notice = null;
    return click.update(await buildPanel(session));
  }
  if (id === 'lotto_random') {
    state.selected = lotto.pickDistinct();
    state.notice = null;
    return click.update(await buildPanel(session));
  }
  if (id === 'lotto_buy') {
    return buy(click, session, state.selected);
  }
  if (id === 'lotto_quick') {
    return buy(click, session, lotto.pickDistinct());
  }
  if (id === 'lotto_close') {
    session.collector?.stop('closed');
    return click.update(farewell('🎱 Menu lotto zamknięte. Wpisz `/lotto` albo kliknij „Kup los” pod ogłoszeniem, żeby wrócić.'));
  }
}

function newSession(interaction) {
  return {
    interaction,
    guildId: interaction.guild.id,
    user: interaction.user,
    collector: null,
    state: { selected: [], notice: null, status: null },
  };
}

// Prywatne menu: wspólne dla komendy /lotto i przycisku "Kup los" pod ogłoszeniem
async function openMenu(interaction) {
  if (!interaction.guild) {
    await interaction.reply({ content: 'Lotto działa tylko na serwerze.', flags: MessageFlags.Ephemeral });
    return;
  }

  const session = newSession(interaction);
  await interaction.reply({ ...(await buildPanel(session)), flags: V2 | MessageFlags.Ephemeral });
  const message = await interaction.fetchReply();

  const collector = message.createMessageComponentCollector({
    filter: (i) => i.user.id === interaction.user.id,
    idle: MENU_IDLE_MS,
    time: MENU_MAX_MS,
  });
  session.collector = collector;

  collector.on('collect', (click) => {
    onClick(click, session).catch(async (err) => {
      console.error('Lotto: błąd obsługi kliknięcia:', err);
      const payload = { content: '❌ Coś poszło nie tak w lotto. Spróbuj ponownie.', flags: MessageFlags.Ephemeral };
      if (click.replied || click.deferred) await click.followUp(payload).catch(() => null);
      else await click.reply(payload).catch(() => null);
    });
  });

  collector.on('end', async (_collected, reason) => {
    if (reason === 'closed') return;
    await interaction.editReply(farewell('⌛ Menu lotto wygasło. Wpisz `/lotto` albo kliknij „Kup los” pod ogłoszeniem, żeby otworzyć je ponownie.')).catch(() => null);
  });
}

// Przycisk "Szybki los" pod ogłoszeniem: kupuje losowy los od razu i odpowiada prywatnie
async function quickBuy(interaction) {
  if (!interaction.guild) {
    await interaction.reply({ content: 'Lotto działa tylko na serwerze.', flags: MessageFlags.Ephemeral });
    return;
  }
  const result = await lotto.buyTicket(interaction.guild.id, interaction.user.id, lotto.pickDistinct());
  await interaction.reply({
    content: result.ok ? `${boughtText(result)}\nLosy: ${result.owned}/${MAX_TICKETS}. Więcej opcji: \`/lotto\`` : (BUY_ERRORS[result.reason] ?? '❌ Nie udało się kupić losu.'),
    flags: MessageFlags.Ephemeral,
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('lotto')
    .setDescription('Lotto Boba: kup los i trafiaj kumulację. Menu jest prywatne.')
    .setDMPermission(false),

  async execute(interaction) {
    await openMenu(interaction);
  },

  openMenu,
  quickBuy,

  // Eksport do testów
  _test: { buildPanel, onClick, newSession },
};
