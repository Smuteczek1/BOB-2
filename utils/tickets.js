const {
  ContainerBuilder,
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
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');
const db = require('../db');

// Czy dana osoba (member) ma prawo zamykać tickety - tylko rola supportu
// skonfigurowana przez admina ORAZ osoby z uprawnieniem "Zarządzaj serwerem".
function canManageTicket(member, config) {
  if (!member) return false;
  if (member.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  if (config?.ticket_support_role_id && member.roles.cache.has(config.ticket_support_role_id)) return true;
  return false;
}

const TICKET_TYPE_SELECT_ID = 'ticket_type_select';
const TICKET_OPEN_MODAL_PREFIX = 'ticket_open_modal_';
const TICKET_CLOSE_BUTTON_ID = 'ticket_close';
const TICKET_CLOSE_CONFIRM_ID = 'ticket_close_confirm';
const TICKET_CLOSE_CANCEL_ID = 'ticket_close_cancel';

const V2_FLAGS = MessageFlags.IsComponentsV2;

const DEFAULT_PANEL_TITLE = '🎫 Centrum pomocy';
const DEFAULT_PANEL_TEXT =
  'Potrzebujesz pomocy albo chcesz coś zgłosić? Wybierz kategorię z listy poniżej, ' +
  'a bot utworzy dla Ciebie prywatny kanał widoczny tylko dla Ciebie i zespołu wsparcia.';
const DEFAULT_PLACEHOLDER = 'Wybierz kategorię ticketu...';

// Co ile wiadomości na kanale ticketu ma się pojawić mały, przypominający panel
// z przyciskiem "Zamknij ticket" - żeby przy intensywnej rozmowie nie trzeba było
// przewijać całego kanału do samej góry.
const CLOSE_REMINDER_EVERY_N_MESSAGES = 10;

// Parsuje emoji podane przez admina w komendzie (unicode albo custom <:nazwa:id> / <a:nazwa:id>)
// i zwraca coś, co da się bezpośrednio podać do .setEmoji() w discord.js.
function parseEmojiInput(raw) {
  if (!raw) return null;
  const customMatch = raw.match(/^<(a)?:(\w+):(\d+)>$/);
  if (customMatch) {
    return { id: customMatch[3], name: customMatch[2], animated: Boolean(customMatch[1]) };
  }
  return raw.trim();
}

// Zamienia hex na liczbę do setAccentColor / setColor. Akceptuje "#FF5733" lub "FF5733".
function parseColorToInt(hex) {
  if (!hex) return 0x5865f2;
  const clean = hex.replace('#', '');
  const parsed = parseInt(clean, 16);
  return Number.isNaN(parsed) ? 0x5865f2 : parsed;
}

function slugify(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // usuwa polskie ogonki (ą -> a, ę -> e, itd.)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'ticket';
}

// Buduje nazwę kanału w formacie emoji-nazwauzytkownika-ID.
// UWAGA: Discord pozwala na zwykłe emoji unicode w nazwie kanału, ale NIE da się
// wstawić customowego emoji serwera (<:nazwa:id>) jako znaku w nazwie - w takim
// wypadku bot używa domyślnego 🎫 zamiast niego.
function buildChannelName(type, username, userId) {
  const emoji = parseEmojiInput(type?.emoji);
  const emojiPrefix = typeof emoji === 'string' && emoji ? emoji : '🎫';
  return `${emojiPrefix}-${slugify(username)}-${userId}`.slice(0, 100);
}

// --- Okno 1: publiczne "wejście" (jedyna wiadomość widoczna na kanale) ---
function buildPanelContainer(config, types) {
  const container = new ContainerBuilder().setAccentColor(0x5865f2);

  const title = config?.ticket_panel_title || DEFAULT_PANEL_TITLE;
  const text = config?.ticket_panel_text || DEFAULT_PANEL_TEXT;

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${title}`),
    new TextDisplayBuilder().setContent(text),
  );

  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

  if (!types || types.length === 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('-# ⚠️ Administracja nie dodała jeszcze żadnej kategorii ticketów.'),
    );
    return container;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(TICKET_TYPE_SELECT_ID)
    .setPlaceholder(config?.ticket_panel_placeholder || DEFAULT_PLACEHOLDER);

  for (const type of types.slice(0, 25)) {
    const option = { label: type.name.slice(0, 100), value: String(type.id) };
    if (type.description) option.description = type.description.slice(0, 100);
    const emoji = parseEmojiInput(type.emoji);
    if (emoji) option.emoji = emoji;
    select.addOptions(option);
  }

  container.addActionRowComponents(new ActionRowBuilder().addComponents(select));

  return container;
}

// --- Modal (okienko) do wpisania pierwszej wiadomości / opisu zgłoszenia,
// pokazywany ZANIM kanał ticketu w ogóle powstanie. ---
function buildTicketOpenModal(type) {
  const modal = new ModalBuilder()
    .setCustomId(`${TICKET_OPEN_MODAL_PREFIX}${type.id}`)
    .setTitle(`Nowy ticket: ${type.name}`.slice(0, 45));

  const descriptionInput = new TextInputBuilder()
    .setCustomId('ticket_description')
    .setLabel('Opisz swój problem / zgłoszenie')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('Im dokładniej opiszesz sprawę, tym szybciej pomoże Ci support.')
    .setMinLength(10)
    .setMaxLength(1000)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(descriptionInput));
  return modal;
}

// --- Buduje GŁÓWNĄ wiadomość powitalną wewnątrz nowo utworzonego kanału ticketu ---
function buildTicketWelcomeContainer(type, member, supportRoleId, isClosingConfirm = false, pingContent = null, description = null) {
  const container = new ContainerBuilder().setAccentColor(parseColorToInt(type?.color));

  // Components V2 nie pozwala na zwykłe pole "content" w wiadomości, więc pingi
  // (@user @rola-supportu) wstawiamy jako zwykły komponent tekstowy na samej górze.
  if (pingContent) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(pingContent));
  }

  const emoji = type?.emoji ? `${type.emoji} ` : '🎫 ';
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${emoji}Ticket: ${type?.name ?? 'Ogólny'}`),
  );

  let intro = `Cześć <@${member.id}>! Dzięki za kontakt.`;
  if (type?.description) intro += `\n${type.description}`;
  intro += supportRoleId
    ? `\nZespół wsparcia (<@&${supportRoleId}>) odezwie się tak szybko, jak to możliwe.`
    : '\nZespół wsparcia odezwie się tak szybko, jak to możliwe.';

  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(intro));

  if (description) {
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`📝 **Opis zgłoszenia:**\n${description}`),
    );
  }

  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

  if (isClosingConfirm) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('⚠️ **Na pewno chcesz zamknąć ten ticket?** Kanał zostanie usunięty.'),
    );
    const confirmButton = new ButtonBuilder()
      .setCustomId(TICKET_CLOSE_CONFIRM_ID)
      .setLabel('Tak, zamknij')
      .setStyle(ButtonStyle.Danger);
    const cancelButton = new ButtonBuilder()
      .setCustomId(TICKET_CLOSE_CANCEL_ID)
      .setLabel('Anuluj')
      .setStyle(ButtonStyle.Secondary);
    container.addActionRowComponents(new ActionRowBuilder().addComponents(confirmButton, cancelButton));
  } else {
    const closeButton = new ButtonBuilder()
      .setCustomId(TICKET_CLOSE_BUTTON_ID)
      .setLabel('Zamknij ticket')
      .setEmoji('🔒')
      .setStyle(ButtonStyle.Danger);
    container.addActionRowComponents(new ActionRowBuilder().addComponents(closeButton));
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('-# Tylko Ty i zespół wsparcia widzicie ten kanał.'),
    );
  }

  return container;
}

// --- Buduje MAŁY, przypominający panel zamykania - wysyłany automatycznie co
// CLOSE_REMINDER_EVERY_N_MESSAGES wiadomości, żeby nie trzeba było szukać głównego
// panelu na górze kanału podczas intensywnej rozmowy. ---
function buildTicketCloseReminderContainer(type, isConfirm = false) {
  const container = new ContainerBuilder().setAccentColor(parseColorToInt(type?.color));

  if (isConfirm) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('⚠️ Na pewno zamknąć ten ticket?'),
    );
    const confirmButton = new ButtonBuilder()
      .setCustomId(TICKET_CLOSE_CONFIRM_ID)
      .setLabel('Tak, zamknij')
      .setStyle(ButtonStyle.Danger);
    const cancelButton = new ButtonBuilder()
      .setCustomId(TICKET_CLOSE_CANCEL_ID)
      .setLabel('Anuluj')
      .setStyle(ButtonStyle.Secondary);
    container.addActionRowComponents(new ActionRowBuilder().addComponents(confirmButton, cancelButton));
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('-# 🔒 Długa rozmowa? Możesz zamknąć ticket bez przewijania w górę.'),
    );
    const closeButton = new ButtonBuilder()
      .setCustomId(TICKET_CLOSE_BUTTON_ID)
      .setLabel('Zamknij ticket')
      .setEmoji('🔒')
      .setStyle(ButtonStyle.Danger);
    container.addActionRowComponents(new ActionRowBuilder().addComponents(closeButton));
  }

  return container;
}

// Sprawdza rzeczywistą liczbę otwartych ticketów danej osoby - jeśli kanał jakiegoś
// ticketu został ręcznie usunięty (np. przez admina bez użycia przycisku "Zamknij"),
// automatycznie oznacza go w bazie jako zamknięty, żeby nie blokował limitu na zawsze.
async function getEffectiveOpenTicketsCount(guild, guildId, userId) {
  const openTickets = await db.getOpenTicketsForUser(guildId, userId);
  let count = 0;

  for (const ticket of openTickets) {
    const channel = guild.channels.cache.get(ticket.channel_id)
      || (await guild.channels.fetch(ticket.channel_id).catch(() => null));

    if (channel) {
      count += 1;
    } else {
      await db.closeTicket(ticket.channel_id, { closedBy: null });
    }
  }

  return count;
}

// Wspólna walidacja przed otwarciem ticketu (kategoria skonfigurowana + limit).
// Zwraca { ok: true, config, type } albo { ok: false, message }.
async function validateTicketOpen(interaction, typeId) {
  const guildId = interaction.guild.id;
  const config = await db.getGuildConfig(guildId);

  if (!config?.ticket_category_id) {
    return { ok: false, message: '⚠️ Administracja nie skonfigurowała jeszcze kategorii ticketów (`/setup-ticket kategoria ustaw`).' };
  }

  const category = await interaction.guild.channels.fetch(config.ticket_category_id).catch(() => null);
  if (!category || category.type !== ChannelType.GuildCategory) {
    return { ok: false, message: '⚠️ Skonfigurowana kategoria ticketów już nie istnieje — zgłoś to administracji.' };
  }

  const limit = config.ticket_limit_per_user ?? 1;
  const openCount = await getEffectiveOpenTicketsCount(interaction.guild, guildId, interaction.user.id);
  if (openCount >= limit) {
    return {
      ok: false,
      message: `⚠️ Masz już otwarte ${openCount} ${openCount === 1 ? 'zgłoszenie' : 'zgłoszenia'} (limit: ${limit}). Zamknij poprzednie, zanim otworzysz nowe.`,
    };
  }

  const type = await db.getTicketType(typeId);
  if (!type) {
    return { ok: false, message: '⚠️ Ta kategoria ticketu już nie istnieje.' };
  }

  return { ok: true, config, category, type };
}

// Kliknięcie opcji w select menu na panelu - najpierw waliduje, potem pokazuje
// modal do wpisania opisu zgłoszenia. Kanał NIE powstaje jeszcze na tym etapie.
async function handleTicketTypeSelect(interaction) {
  const typeId = interaction.values[0];
  const validation = await validateTicketOpen(interaction, typeId);

  if (!validation.ok) {
    await interaction.reply({ content: validation.message, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.showModal(buildTicketOpenModal(validation.type));
}

// Wysłanie modala z opisem zgłoszenia - dopiero teraz faktycznie tworzymy kanał.
async function handleTicketOpenModalSubmit(interaction) {
  const typeId = interaction.customId.slice(TICKET_OPEN_MODAL_PREFIX.length);
  const description = interaction.fields.getTextInputValue('ticket_description');

  // Ponowna walidacja "na świeżo" (mogło minąć trochę czasu, zanim ktoś wypełnił modal).
  const validation = await validateTicketOpen(interaction, typeId);
  if (!validation.ok) {
    await interaction.reply({ content: validation.message, flags: MessageFlags.Ephemeral });
    return;
  }

  const { config, category, type } = validation;
  const guildId = interaction.guild.id;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const permissionOverwrites = [
    { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: interaction.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
      ],
    },
    {
      id: interaction.client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
      ],
    },
  ];

  if (config.ticket_support_role_id) {
    permissionOverwrites.push({
      id: config.ticket_support_role_id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
      ],
    });
  }

  let channel;
  try {
    channel = await interaction.guild.channels.create({
      name: buildChannelName(type, interaction.user.username, interaction.user.id),
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites,
      topic: `Ticket (${type.name}) — otworzył/a ${interaction.user.tag} (${interaction.user.id})`,
    });
  } catch (err) {
    console.error('Błąd podczas tworzenia kanału ticketu:', err);
    await interaction.editReply({
      content:
        '❌ Nie udało się utworzyć kanału. Sprawdź, czy bot ma uprawnienie **Zarządzaj kanałami** ' +
        'w skonfigurowanej kategorii ticketów.',
    });
    return;
  }

  await db.createTicket(guildId, { channelId: channel.id, userId: interaction.user.id, typeId: type.id, description });

  const pingContent = config.ticket_support_role_id
    ? `<@${interaction.user.id}> <@&${config.ticket_support_role_id}>`
    : `<@${interaction.user.id}>`;

  const welcomeContainer = buildTicketWelcomeContainer(
    type,
    interaction.member,
    config.ticket_support_role_id,
    false,
    pingContent,
    description,
  );

  const welcomeMessage = await channel.send({
    components: [welcomeContainer],
    flags: V2_FLAGS,
    allowedMentions: { users: [interaction.user.id], roles: config.ticket_support_role_id ? [config.ticket_support_role_id] : [] },
  });

  await db.setTicketWelcomeMessageId(channel.id, welcomeMessage.id);

  await interaction.editReply({ content: `✅ Twój ticket został utworzony: ${channel}` });
}

// Kliknięcie "Zamknij ticket" (na głównym panelu ALBO na mini-panelu przypominającym)
// - pokazuje ekran potwierdzenia w TEJ SAMEJ wiadomości, w odpowiednim rozmiarze.
async function handleTicketCloseClick(interaction) {
  const ticket = await db.getTicketByChannel(interaction.channel.id);
  if (!ticket) {
    await interaction.reply({ content: '⚠️ Nie znaleziono danych tego ticketu w bazie.', flags: MessageFlags.Ephemeral });
    return;
  }

  const config = await db.getGuildConfig(interaction.guild.id);

  if (!canManageTicket(interaction.member, config)) {
    await interaction.reply({
      content: '⛔ Tylko support może zamknąć ten ticket.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const type = ticket.type_id ? await db.getTicketType(ticket.type_id) : null;
  const isMain = interaction.message.id === ticket.welcome_message_id;

  const confirmContainer = isMain
    ? buildTicketWelcomeContainer(type, { id: ticket.user_id }, config?.ticket_support_role_id, true, null, ticket.description)
    : buildTicketCloseReminderContainer(type, true);

  await interaction.update({ components: [confirmContainer], flags: V2_FLAGS });
}

// Kliknięcie "Anuluj" na ekranie potwierdzenia - wraca do normalnego widoku (dużego
// głównego panelu albo małego przypominacza, w zależności od tego, która wiadomość to była).
async function handleTicketCloseCancel(interaction) {
  const ticket = await db.getTicketByChannel(interaction.channel.id);
  const type = ticket?.type_id ? await db.getTicketType(ticket.type_id) : null;
  const config = await db.getGuildConfig(interaction.guild.id);
  const isMain = interaction.message.id === ticket?.welcome_message_id;

  const container = isMain
    ? buildTicketWelcomeContainer(type, { id: ticket?.user_id ?? interaction.user.id }, config?.ticket_support_role_id, false, null, ticket?.description)
    : buildTicketCloseReminderContainer(type, false);

  await interaction.update({ components: [container], flags: V2_FLAGS });
}

// Kliknięcie "Tak, zamknij" - zapisuje zamknięcie w bazie i usuwa kanał po krótkim odliczeniu.
async function handleTicketCloseConfirm(interaction) {
  const config = await db.getGuildConfig(interaction.guild.id);

  if (!canManageTicket(interaction.member, config)) {
    await interaction.reply({
      content: '⛔ Tylko support może zamknąć ten ticket.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await db.closeTicket(interaction.channel.id, { closedBy: interaction.user.id });

  // Wiadomość z Components V2 nie może mieć zwykłego "content" obok komponentów,
  // więc ekran zamykania też budujemy jako prosty kontener.
  const closingContainer = new ContainerBuilder()
    .setAccentColor(0xed4245)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `🔒 Ticket zamknięty przez <@${interaction.user.id}>. Kanał zniknie za kilka sekund...`,
      ),
    );

  await interaction.update({ components: [closingContainer], flags: V2_FLAGS }).catch(() => null);

  setTimeout(() => {
    interaction.channel.delete('Ticket zamknięty').catch(err => console.error('Błąd podczas usuwania kanału ticketu:', err));
  }, 5000);
}

// Wywoływane z events/ticketMessageCount.js przy każdej NOWEJ wiadomości na serwerze.
// Zwiększa licznik wiadomości ticketu (jeśli to kanał ticketu) i co N wiadomości
// wysyła mały panel przypominający o możliwości zamknięcia.
async function handleTicketMessageForReminder(message) {
  if (message.author.bot) return;
  if (!message.guild) return;

  const ticket = await db.getTicketByChannel(message.channel.id);
  if (!ticket || ticket.status !== 'open') return;

  const count = await db.incrementTicketMessageCount(message.channel.id);
  if (count === 0 || count % CLOSE_REMINDER_EVERY_N_MESSAGES !== 0) return;

  const type = ticket.type_id ? await db.getTicketType(ticket.type_id) : null;
  const reminderContainer = buildTicketCloseReminderContainer(type, false);

  await message.channel.send({ components: [reminderContainer], flags: V2_FLAGS }).catch(err =>
    console.error('Błąd podczas wysyłania mini-panelu zamykania ticketu:', err),
  );
}

module.exports = {
  TICKET_TYPE_SELECT_ID,
  TICKET_OPEN_MODAL_PREFIX,
  TICKET_CLOSE_BUTTON_ID,
  TICKET_CLOSE_CONFIRM_ID,
  TICKET_CLOSE_CANCEL_ID,
  V2_FLAGS,
  DEFAULT_PANEL_TITLE,
  DEFAULT_PANEL_TEXT,
  DEFAULT_PLACEHOLDER,
  CLOSE_REMINDER_EVERY_N_MESSAGES,
  parseEmojiInput,
  parseColorToInt,
  buildPanelContainer,
  buildTicketOpenModal,
  buildTicketWelcomeContainer,
  buildTicketCloseReminderContainer,
  handleTicketTypeSelect,
  handleTicketOpenModalSubmit,
  handleTicketCloseClick,
  handleTicketCloseCancel,
  handleTicketCloseConfirm,
  handleTicketMessageForReminder,
};
