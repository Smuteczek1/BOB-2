const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
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
  lines.push(
    'Jeśli nikt nie trafi wszystkich liczb, pula przechodzi na następne losowanie. ' +
    `Po każdym losowaniu Bob zaokrągla ją w górę do pełnych ${lotto.ROUND_STEP}, a po wygranej startuje nowa, losowa kumulacja.`,
  );
  return lines.join('\n');
}

async function buildPanel(session, { disabled = false } = {}) {
  const { state } = session;
  const status = await lotto.getStatus(session.guildId, session.user.id);
  state.status = status;

  const atLimit = status.tickets.length >= MAX_TICKETS;
  const ready = state.selected.length === PICK;
  const tooMany = state.selected.length > PICK;

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
      ? `**Wybrane liczby:** ${lotto.formatNumbers(state.selected)}` +
        (ready ? '' : tooMany ? ` _(za dużo, odznacz ${state.selected.length - PICK})_` : ` _(wybierz jeszcze ${PICK - state.selected.length})_`)
      : `Kliknij ✏️, żeby wpisać ${PICK} liczby (1-${RANGE}), albo 🎲, żeby wylosować.`,
  ];
  if (state.notice) lines.unshift(state.notice, '');

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('🎱 Lotto Boba')
    .setDescription(lines.join('\n'))
    .addFields({ name: 'Nagrody', value: prizeLines() })
    .setFooter({ text: 'To menu widzisz tylko Ty. Wyniki losowania ogłasza Bob publicznie.' });

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('lotto_buy')
      .setLabel(`Kup los (${PRICE})`)
      .setEmoji('🎟️')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled || atLimit || !ready),
    new ButtonBuilder()
      .setCustomId('lotto_type')
      .setLabel('Wpisz liczby')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled || atLimit),
    new ButtonBuilder()
      .setCustomId('lotto_random')
      .setLabel('Losuj')
      .setEmoji('🎲')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || atLimit),
    new ButtonBuilder()
      .setCustomId('lotto_quick')
      .setLabel('Kup losowy')
      .setEmoji('⚡')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled || atLimit),
    new ButtonBuilder().setCustomId('lotto_close').setLabel('Zamknij').setEmoji('✖️').setStyle(ButtonStyle.Danger).setDisabled(disabled),
  );

  return { content: '', embeds: [embed], components: [buttons] };
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

  if (id === 'lotto_type') {
    const modal = new ModalBuilder()
      .setCustomId(`lotto_modal_${click.id}`)
      .setTitle('Twoje liczby')
      .addComponents(
        ...Array.from({ length: PICK }, (_, i) =>
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId(`n${i}`)
              .setLabel(`Liczba ${i + 1} (1-${RANGE})`)
              .setPlaceholder('np. 7')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMinLength(1)
              .setMaxLength(String(RANGE).length),
          ),
        ),
      );
    await click.showModal(modal);
    const submit = await click
      .awaitModalSubmit({ filter: (i) => i.customId === modal.data.custom_id && i.user.id === click.user.id, time: 120_000 })
      .catch(() => null);
    if (!submit) return; // okienko zamknięte bez wysłania
    const nums = lotto.normalizeNumbers(
      Array.from({ length: PICK }, (_, i) => submit.fields.getTextInputValue(`n${i}`).trim()),
    );
    if (nums) {
      state.selected = nums;
      state.notice = null;
    } else {
      state.notice = `⚠️ Wpisz ${PICK} różne liczby z zakresu 1-${RANGE} (bez powtórek i liter).`;
    }
    return submit.update(await buildPanel(session));
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
    .setDescription('Lotto Boba: kup los i trafiaj kumulację. Menu jest prywatne.')
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
