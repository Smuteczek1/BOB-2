const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  MessageFlags,
} = require('discord.js');
const { formatCoins } = require('../utils/economy');
const lotto = require('../utils/lotto');

// ============================================================
//  /lotto: PRYWATNE menu (widzisz je tylko Ty). Losowanie i wyniki są publiczne
//  na kanale ustawionym przez /setup-lotto.
// ============================================================

const MENU_IDLE_MS = 5 * 60 * 1000;
const MENU_MAX_MS = 14 * 60 * 1000;

const { PICK, RANGE, PRICE, MAX_TICKETS } = lotto;

function prizeLines() {
  const lines = [`🏆 Trafione **${PICK} z ${PICK}**: **cała kumulacja** (dzielona, jeśli trafi kilka osób)`];
  for (let m = PICK - 1; m >= PICK - 2; m--) {
    const prize = lotto.prizeFor(m);
    lines.push(`• Trafione **${m}**: ${formatCoins(prize)}${prize === PRICE ? ' (zwrot losu)' : ''}`);
  }
  lines.push('Jeśli nikt nie trafi wszystkich liczb, pula przechodzi na następne losowanie.');
  return lines.join('\n');
}

async function buildPanel(session, { disabled = false } = {}) {
  const { state } = session;
  const status = await lotto.getStatus(session.guildId, session.user.id);
  state.status = status;

  const atLimit = status.tickets.length >= MAX_TICKETS;
  const ready = state.selected.length === PICK;

  const ticketList = status.tickets.length
    ? status.tickets.map((t, i) => `${i + 1}. **${lotto.formatNumbers(t.numbers)}**`).join('\n')
    : '_Nie masz jeszcze losów na to losowanie._';

  const lines = [
    `# 🎟️ Kumulacja: ${formatCoins(status.pool)}`,
    `Następne losowanie: <t:${Math.floor(status.drawAt / 1000)}:F> (<t:${Math.floor(status.drawAt / 1000)}:R>)`,
    `Cena losu: ${formatCoins(PRICE)} • Wybierasz **${PICK}** liczby z **${RANGE}** • Saldo: ${formatCoins(status.balance)}`,
    '',
    `**Twoje losy (${status.tickets.length}/${MAX_TICKETS}):**`,
    ticketList,
    '',
    state.selected.length > 0
      ? `**Wybrane liczby:** ${lotto.formatNumbers(state.selected)}${ready ? '' : ` _(wybierz jeszcze ${PICK - state.selected.length})_`}`
      : `Wybierz ${PICK} liczby z listy poniżej albo kliknij 🎲, żeby wylosować.`,
  ];
  if (state.notice) lines.unshift(state.notice, '');

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('🎱 Lotto Boba')
    .setDescription(lines.join('\n'))
    .addFields({ name: 'Nagrody', value: prizeLines() })
    .setFooter({ text: 'To menu widzisz tylko Ty. Wyniki losowania ogłasza Bob publicznie.' });

  const select = new StringSelectMenuBuilder()
    .setCustomId('lotto_pick')
    .setPlaceholder(`Wybierz ${PICK} liczby (1-${RANGE})`)
    .setMinValues(PICK)
    .setMaxValues(PICK)
    .setDisabled(disabled || atLimit)
    .addOptions(
      Array.from({ length: RANGE }, (_, i) => ({
        label: String(i + 1),
        value: String(i + 1),
        default: state.selected.includes(i + 1),
      })),
    );

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('lotto_buy')
      .setLabel(`Kup los (${PRICE})`)
      .setEmoji('🎟️')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled || atLimit || !ready),
    new ButtonBuilder()
      .setCustomId('lotto_random')
      .setLabel('Losowe liczby')
      .setEmoji('🎲')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || atLimit),
    new ButtonBuilder()
      .setCustomId('lotto_quick')
      .setLabel(`Kup losowy los`)
      .setEmoji('⚡')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled || atLimit),
    new ButtonBuilder().setCustomId('lotto_close').setLabel('Zamknij').setEmoji('✖️').setStyle(ButtonStyle.Danger).setDisabled(disabled),
  );

  return { content: '', embeds: [embed], components: [new ActionRowBuilder().addComponents(select), buttons] };
}

const BUY_ERRORS = {
  funds: `💸 Nie stać Cię na los (${PRICE} monet). Odbierz \`/nagroda\`.`,
  limit: `🚫 Masz już maksymalną liczbę losów na to losowanie (${MAX_TICKETS}).`,
  invalid: '⚠️ Wybierz poprawne liczby.',
};

async function buy(click, session, numbers) {
  const { state } = session;
  const result = await lotto.buyTicket(session.guildId, session.user.id, numbers);

  if (!result.ok) {
    state.notice = BUY_ERRORS[result.reason] ?? '❌ Nie udało się kupić losu.';
  } else {
    state.selected = [];
    state.notice =
      `✅ Kupiono los **${lotto.formatNumbers(result.numbers)}** na losowanie <t:${Math.floor(lotto.drawTimestamp(result.drawDate) / 1000)}:R>. ` +
      `Pula: ${formatCoins(result.pool)}. Powodzenia!`;
  }
  await click.update(await buildPanel(session));
}

async function onClick(click, session) {
  const { state } = session;
  const id = click.customId;

  if (id === 'lotto_pick') {
    const nums = lotto.normalizeNumbers(click.values);
    if (nums) state.selected = nums;
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
    return click.update({ content: '🎱 Menu lotto zamknięte. Wpisz `/lotto`, żeby wrócić.', embeds: [], components: [] });
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

module.exports = {
  data: new SlashCommandBuilder()
    .setName('lotto')
    .setDescription('Lotto Boba: kup los za 100 monet i trafiaj kumulację. Menu jest prywatne.')
    .setDMPermission(false),

  async execute(interaction) {
    if (!interaction.guild) {
      await interaction.reply({ content: 'Lotto działa tylko na serwerze.', flags: MessageFlags.Ephemeral });
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
        console.error('Lotto: błąd obsługi kliknięcia:', err);
        const payload = { content: '❌ Coś poszło nie tak w lotto. Spróbuj ponownie.', flags: MessageFlags.Ephemeral };
        if (click.replied || click.deferred) await click.followUp(payload).catch(() => null);
        else await click.reply(payload).catch(() => null);
      });
    });

    collector.on('end', async (_collected, reason) => {
      if (reason === 'closed') return;
      await interaction
        .editReply({ content: '⌛ Menu lotto wygasło. Wpisz `/lotto`, żeby otworzyć je ponownie.', embeds: [], components: [] })
        .catch(() => null);
    });
  },

  // Eksport do testów
  _test: { buildPanel, onClick, newSession },
};
