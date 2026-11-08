const {
  SlashCommandBuilder,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
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
const items = require('../utils/items');
const market = require('../utils/market');

// ============================================================
//  /rynek: PRYWATNE menu rynku graczy (Components V2, jak /sklep).
//  Zakładki: Oferty (kupno) · Wystaw przedmiot · Moje oferty (anulowanie, ostatnie sprzedaże).
//  Wystawiony przedmiot leży w depozycie do sprzedaży/anulowania/wygaśnięcia (patrz utils/market.js).
// ============================================================

const pct = (rate) => Math.round(rate * 1000) / 10; // 0.046 -> 4.6
const V2 = MessageFlags.IsComponentsV2;
const IDLE_MS = 5 * 60_000;
const MAX_MS = 14 * 60_000;
const PER_PAGE = 5;

const text = (s) => new TextDisplayBuilder().setContent(s);
const sep = () => new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small);
const coin = (n) => `**${Number(n).toLocaleString('pl-PL')}** 🪙`;
const nameOf = (id) => `${items.ITEMS[id].emoji} **${items.ITEMS[id].name}**`;
const tierTag = (id) => `${items.TIER_ICONS[items.ITEMS[id].tier]} ${items.TIER_NAMES[items.ITEMS[id].tier]}`;
const levelNote = (id) => (items.ITEMS[id].maxLevel ? ' · +1 poziom' : '');
const range = (id) => {
  const [min, max] = market.priceRange(id);
  return `${min.toLocaleString('pl-PL')} – ${max.toLocaleString('pl-PL')} 🪙`;
};

const ERRORS = {
  gone: '⌛ Ta oferta nie jest już dostępna (ktoś ją kupił, anulował albo wygasła). Nic nie zostało pobrane.',
  own: '🚫 To twoja własna oferta.',
  funds: '💸 Nie masz tyle monet. Nic nie zostało pobrane.',
  cannot_hold: '🚫 Nie możesz kupić tego przedmiotu: masz już ten unikat albo jego maksymalny poziom. Nic nie zostało pobrane.',
  limit: '🚫 Masz już maksymalną liczbę ofert. Anuluj którąś w zakładce „Moje oferty”.',
  missing: '🚫 Nie masz już tego przedmiotu.',
  item: '🚫 Tego przedmiotu nie da się sprzedać.',
};

function newSession(interaction) {
  return {
    interaction,
    guildId: interaction.guild.id,
    user: interaction.user,
    collector: null,
    state: { view: 'offers', tier: null, page: 0, confirm: null, sellItem: null, notice: null },
  };
}

async function getBalance(session) {
  const acc = await db.getEconomyAccount(session.guildId, session.user.id);
  return Number(acc?.balance ?? 0);
}

// ---------------- WIDOKI ----------------
function tabsRow(view, disabled) {
  const tab = (id, label, emoji, key) =>
    new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(view === key ? ButtonStyle.Primary : ButtonStyle.Secondary).setDisabled(disabled);
  return new ActionRowBuilder().addComponents(
    tab('mk_tab_offers', 'Oferty', '🛒', 'offers'),
    tab('mk_tab_sell', 'Wystaw', '🏷️', 'sell'),
    tab('mk_tab_mine', 'Moje oferty', '📦', 'mine'),
    new ButtonBuilder().setCustomId('mk_close').setLabel('Zamknij').setEmoji('✖️').setStyle(ButtonStyle.Danger).setDisabled(disabled),
  );
}

async function offersView(session, box, disabled) {
  const { state } = session;

  // Potwierdzenie zakupu (żeby nie kupić przez przypadek)
  if (state.confirm) {
    const l = state.confirm;
    box.addTextDisplayComponents(
      text(
        `### 🛒 Potwierdź zakup\n${nameOf(l.itemId)} (${tierTag(l.itemId)})${levelNote(l.itemId)}\n` +
        `Cena: ${coin(l.price)} · sprzedaje <@${l.sellerId}>`,
      ),
    );
    box.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('mk_confirm_yes').setLabel('Kupuję').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(disabled),
        new ButtonBuilder().setCustomId('mk_confirm_no').setLabel('Anuluj').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
      ),
    );
    return;
  }

  const { rows, total } = await market.getListings(session.guildId, { tier: state.tier, limit: PER_PAGE, offset: state.page * PER_PAGE });
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  if (state.page > pages - 1 && state.page > 0) {
    state.page = pages - 1;
    return offersView(session, box, disabled);
  }

  box.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('mk_tier')
        .setPlaceholder('Filtr rzadkości')
        .setDisabled(disabled)
        .addOptions([
          { label: 'Wszystkie rzadkości', value: 'all', default: state.tier === null },
          ...Object.keys(items.TIER_NAMES).map((t) => ({
            label: items.TIER_NAMES[t],
            value: String(t),
            emoji: items.TIER_ICONS[t],
            default: state.tier === Number(t),
          })),
        ]),
    ),
  );

  box.addTextDisplayComponents(text(`### 🛒 Oferty (${total})`));
  if (rows.length === 0) {
    box.addTextDisplayComponents(text('_Brak ofert. Wystaw coś w zakładce „Wystaw”!_'));
  }
  for (const l of rows) {
    const mine = l.sellerId === session.user.id;
    box.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          text(
            `${tierTag(l.itemId)}\n${nameOf(l.itemId)}${levelNote(l.itemId)}\n` +
            `-# ${coin(l.price)} · ${mine ? '**twoja oferta**' : `sprzedaje <@${l.sellerId}>`} · wygasa <t:${Math.floor(l.expiresAt / 1000)}:R>`,
          ),
        )
        .setButtonAccessory(
          new ButtonBuilder().setCustomId(`mk_buy:${l.id}`).setLabel(mine ? 'Twoja' : 'Kup').setEmoji('🛒').setStyle(ButtonStyle.Success).setDisabled(disabled || mine),
        ),
    );
  }

  if (pages > 1) {
    box.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('mk_prev').setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(disabled || state.page === 0),
        new ButtonBuilder().setCustomId('mk_pageinfo').setLabel(`${state.page + 1} / ${pages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('mk_next').setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(disabled || state.page >= pages - 1),
      ),
    );
  }
}

async function sellView(session, box, disabled) {
  const { state } = session;
  const [sellable, mineNow] = await Promise.all([market.getSellable(session.guildId, session.user.id), market.getMyListings(session.guildId, session.user.id)]);
  const perks = session.perks ?? (await market.perksFor(session.guildId, session.user.id));
  const atLimit = mineNow.length >= perks.limit;

  box.addTextDisplayComponents(
    text(
      `### 🏷️ Wystaw przedmiot\nWybierz przedmiot, potem ustal cenę. Przedmiot trafia do depozytu do czasu sprzedaży, anulowania albo wygaśnięcia (${market.LISTING_DAYS} dni).\n` +
      `-# Prowizja ${pct(perks.fee)}% płaci sprzedawca · twoje oferty: ${mineNow.length}/${perks.limit}` +
      (atLimit ? '\n-# 🚫 Limit ofert osiągnięty.' : ''),
    ),
  );

  // Wybrany przedmiot musi nadal być w ekwipunku
  if (state.sellItem && !sellable.some((s) => s.itemId === state.sellItem)) state.sellItem = null;

  if (sellable.length === 0) {
    box.addTextDisplayComponents(text('_Nie masz żadnych przedmiotów do sprzedania. Przedmioty zdobędziesz ze skrzyń (`/sklep`, `/nagroda`)._'));
    return;
  }

  box.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('mk_sellpick')
        .setPlaceholder('Wybierz przedmiot z ekwipunku')
        .setDisabled(disabled || atLimit)
        .addOptions(
          sellable.slice(0, 25).map((s) => ({
            label: `${items.ITEMS[s.itemId].name} ×${s.quantity}`.slice(0, 100),
            description: `${items.TIER_NAMES[items.ITEMS[s.itemId].tier]} · widełki ${range(s.itemId)}`.slice(0, 100),
            value: s.itemId,
            emoji: items.ITEMS[s.itemId].emoji,
            default: state.sellItem === s.itemId,
          })),
        ),
    ),
  );

  if (state.sellItem) {
    const sug = await market.suggestedPrice(session.guildId, state.sellItem);
    state.suggested = sug.price;
    box.addSeparatorComponents(sep());
    box.addTextDisplayComponents(
      text(
        `### ${nameOf(state.sellItem)}\n${tierTag(state.sellItem)}${levelNote(state.sellItem)}\n` +
        `Dozwolona cena: **${range(state.sellItem)}**\n` +
        `Sugerowana: ${coin(sug.price)} _(${sug.fromSales > 0 ? `średnia z ostatnich ${sug.fromSales} sprzedaży` : 'brak historii, środek widełek'})_`,
      ),
    );
    box.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('mk_sell_suggested').setLabel(`Wystaw za ${sug.price.toLocaleString('pl-PL')}`).setEmoji('⚡').setStyle(ButtonStyle.Success).setDisabled(disabled || atLimit),
        new ButtonBuilder().setCustomId('mk_sell_price').setLabel('Własna cena').setEmoji('💰').setStyle(ButtonStyle.Primary).setDisabled(disabled || atLimit),
      ),
    );
  }
}

async function mineView(session, box, disabled) {
  const [mine, sales] = await Promise.all([
    market.getMyListings(session.guildId, session.user.id),
    market.getRecentSales(session.guildId, session.user.id, 3),
  ]);

  box.addTextDisplayComponents(text(`### 📦 Moje oferty (${mine.length}/${(session.perks ?? (await market.perksFor(session.guildId, session.user.id))).limit})`));
  if (mine.length === 0) box.addTextDisplayComponents(text('_Nie masz aktywnych ofert._'));
  for (const l of mine) {
    box.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          text(
            `${tierTag(l.itemId)}\n${nameOf(l.itemId)}\n` +
            `-# ${coin(l.price)} (dostaniesz ${coin(l.price - market.feeOf(l.price, session.perks?.level))}) · wygasa <t:${Math.floor(l.expiresAt / 1000)}:R>`,
          ),
        )
        .setButtonAccessory(
          new ButtonBuilder().setCustomId(`mk_cancel:${l.id}`).setLabel('Anuluj').setEmoji('↩️').setStyle(ButtonStyle.Danger).setDisabled(disabled),
        ),
    );
  }

  if (sales.length > 0) {
    box.addSeparatorComponents(sep());
    box.addTextDisplayComponents(
      text(
        '### 💸 Ostatnio sprzedane\n' +
        sales.map((s) => `• ${nameOf(s.itemId)} za ${coin(s.price)} → <@${s.buyerId}> _(dostałeś/aś ${coin(s.price - s.fee)})_`).join('\n'),
      ),
    );
  }
}

async function buildPanel(session, { disabled = false } = {}) {
  const { state } = session;
  const balance = await getBalance(session);
  session.perks = await market.perksFor(session.guildId, session.user.id);
  const box = new ContainerBuilder().setAccentColor(0x16a085);

  if (state.notice) {
    box.addTextDisplayComponents(text(state.notice));
    box.addSeparatorComponents(sep());
  }
  box.addTextDisplayComponents(
    text(`## 🏪 Rynek Boba\n-# Kupuj i sprzedawaj przedmioty innych graczy · prowizja ${pct(session.perks.fee)}% · saldo: ${coin(balance)}`),
  );
  box.addActionRowComponents(tabsRow(state.view, disabled));
  box.addSeparatorComponents(sep());

  if (state.view === 'sell') await sellView(session, box, disabled);
  else if (state.view === 'mine') await mineView(session, box, disabled);
  else await offersView(session, box, disabled);

  return { components: [box], flags: V2 };
}

const farewell = (msg) => ({ components: [new ContainerBuilder().setAccentColor(0x95a5a6).addTextDisplayComponents(text(msg))], flags: V2 });

// ---------------- AKCJE ----------------
async function render(session) {
  const payload = await buildPanel(session);
  try {
    await session.interaction.editReply(payload);
  } catch {
    await new Promise((r) => setTimeout(r, 700));
    await session.interaction.editReply(payload);
  }
}

async function doSell(session, price) {
  const { state } = session;
  const itemId = state.sellItem;
  const r = await market.listItem(session.guildId, session.user.id, itemId, price);
  if (r.ok) {
    state.notice = `✅ Wystawiono ${nameOf(itemId)} za ${coin(price)}. Dostaniesz ${coin(price - market.feeOf(price, session.perks?.level))} po prowizji. Oferta wygasa <t:${Math.floor(r.expiresAt / 1000)}:R>.`;
    state.sellItem = null;
  } else if (r.reason === 'price') {
    state.notice = `⚠️ Cena poza widełkami. Dla tego przedmiotu: **${r.min.toLocaleString('pl-PL')} – ${r.max.toLocaleString('pl-PL')}** 🪙.`;
  } else {
    state.notice = ERRORS[r.reason] ?? '❌ Nie udało się wystawić przedmiotu.';
  }
}

async function onClick(click, session) {
  const { state } = session;
  const id = click.customId;

  // Modal z ceną musi zostać pokazany natychmiast (bez deferUpdate)
  if (id === 'mk_sell_price') {
    if (!state.sellItem) return click.deferUpdate();
    const [min, max] = market.priceRange(state.sellItem);
    const modal = new ModalBuilder()
      .setCustomId('mk_price_modal')
      .setTitle('Cena oferty')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('price')
            .setLabel(`Cena w monetach (${min.toLocaleString('pl-PL')} – ${max.toLocaleString('pl-PL')})`.slice(0, 45))
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(String(state.suggested ?? min))
            .setRequired(true)
            .setMaxLength(14),
        ),
      );
    await click.showModal(modal);
    const sub = await click
      .awaitModalSubmit({ time: 120_000, filter: (i) => i.customId === 'mk_price_modal' && i.user.id === click.user.id })
      .catch(() => null);
    if (!sub) return;
    await sub.deferUpdate();
    const price = market.parsePrice(sub.fields.getTextInputValue('price'));
    if (price === null) state.notice = '⚠️ Nie rozumiem tej ceny. Wpisz liczbę, np. `4200`, `4 200` albo `4,2k`.';
    else await doSell(session, price);
    return render(session);
  }

  await click.deferUpdate();
  state.notice = null;

  if (id === 'mk_close') {
    session.collector?.stop('closed');
    return session.interaction.editReply(farewell('🏪 Rynek zamknięty. Wpisz `/rynek`, żeby wrócić.'));
  }
  if (id === 'mk_tab_offers' || id === 'mk_tab_sell' || id === 'mk_tab_mine') {
    state.view = id === 'mk_tab_offers' ? 'offers' : id === 'mk_tab_sell' ? 'sell' : 'mine';
    state.confirm = null;
    return render(session);
  }
  if (id === 'mk_tier') {
    state.tier = click.values[0] === 'all' ? null : Number(click.values[0]);
    state.page = 0;
    return render(session);
  }
  if (id === 'mk_prev' || id === 'mk_next') {
    state.page = Math.max(0, state.page + (id === 'mk_next' ? 1 : -1));
    return render(session);
  }
  if (id.startsWith('mk_buy:')) {
    const listingId = Number(id.slice('mk_buy:'.length));
    const l = await market.getListing(session.guildId, listingId);
    if (!l) state.notice = ERRORS.gone;
    else state.confirm = l;
    return render(session);
  }
  if (id === 'mk_confirm_no') {
    state.confirm = null;
    return render(session);
  }
  if (id === 'mk_confirm_yes') {
    const l = state.confirm;
    state.confirm = null;
    if (!l) return render(session);
    const r = await market.buyListing(session.guildId, session.user.id, l.id);
    state.notice = r.ok
      ? `✅ **Kupiono** ${nameOf(r.itemId)} za ${coin(r.price)}. Przedmiot jest w \`/ekwipunek\`. Saldo: ${coin(r.balance)}`
      : (ERRORS[r.reason] ?? '❌ Nie udało się kupić.');
    return render(session);
  }
  if (id === 'mk_sellpick') {
    state.sellItem = click.values[0];
    return render(session);
  }
  if (id === 'mk_sell_suggested') {
    if (state.sellItem) await doSell(session, (await market.suggestedPrice(session.guildId, state.sellItem)).price);
    return render(session);
  }
  if (id.startsWith('mk_cancel:')) {
    const r = await market.cancelListing(session.guildId, session.user.id, Number(id.slice('mk_cancel:'.length)));
    state.notice = r.ok
      ? `↩️ Oferta anulowana: ${nameOf(r.itemId)} wrócił do ekwipunku.${r.compensated ? ` (Nie mogłeś go już przyjąć, więc dostałeś ${coin(r.compensated)} rekompensaty.)` : ''}`
      : (ERRORS.gone);
    return render(session);
  }
  return render(session);
}

// Wspólne dla /rynek i przycisku "Rynek" w /sklep
async function openMenu(interaction) {
  if (!interaction.guild) {
    await interaction.reply({ content: 'Rynek działa tylko na serwerze.', flags: MessageFlags.Ephemeral });
    return;
  }
  const session = newSession(interaction);

  // Wygasłe oferty tej osoby wracają do ekwipunku od razu
  const returned = await market.expireDue({ guildId: session.guildId, userId: session.user.id }).catch(() => 0);
  if (returned > 0) session.state.notice = `↩️ ${returned} ${returned === 1 ? 'wygasła oferta wróciła' : 'wygasłe oferty wróciły'} do twojego ekwipunku.`;

  await interaction.reply({ ...(await buildPanel(session)), flags: V2 | MessageFlags.Ephemeral });
  const message = await interaction.fetchReply();

  const collector = message.createMessageComponentCollector({
    filter: (i) => i.user.id === interaction.user.id,
    idle: IDLE_MS,
    time: MAX_MS,
  });
  session.collector = collector;

  collector.on('collect', (click) => {
    onClick(click, session).catch(async (err) => {
      console.error('Rynek: błąd obsługi kliknięcia:', err);
      const payload = { content: '❌ Coś poszło nie tak na rynku. Sprawdź `/ekwipunek` i spróbuj ponownie.', flags: MessageFlags.Ephemeral };
      if (click.replied || click.deferred) await click.followUp(payload).catch(() => null);
      else await click.reply(payload).catch(() => null);
    });
  });

  collector.on('end', async (_c, reason) => {
    if (reason === 'closed') return;
    await interaction.editReply(farewell('⌛ Rynek wygasł. Wpisz `/rynek`, żeby otworzyć go ponownie.')).catch(() => null);
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rynek')
    .setDescription('Rynek graczy: kupuj i sprzedawaj przedmioty (prowizja 5%).')
    .setDMPermission(false),

  async execute(interaction) {
    await openMenu(interaction);
  },

  openMenu,

  // Eksport do testów
  _test: { buildPanel, onClick, newSession },
};
