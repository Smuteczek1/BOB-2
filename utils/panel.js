const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} = require('discord.js');
const db = require('../db');

const V2_FLAGS = MessageFlags.IsComponentsV2;

// --- Nawigacja główna ---
const PANEL_HOME_ID = 'panel_home';
const PANEL_CATEGORY_PREFIX = 'panel_cat_';

// --- Kategoria: Onboarding (powitania / pożegnania / rola startowa) ---
const ONB_BACK_ID = 'panel_onb_back';
const ONB_WELCOME_OPEN_ID = 'panel_onb_powitania';
const ONB_WELCOME_CHANNEL_ID = 'panel_onb_powitania_channel';
const ONB_WELCOME_TOGGLE_ID = 'panel_onb_powitania_toggle';
const ONB_WELCOME_EDIT_ID = 'panel_onb_powitania_edit';
const ONB_WELCOME_EDIT_MODAL_ID = 'panel_onb_powitania_edit_modal';
const ONB_GOODBYE_OPEN_ID = 'panel_onb_pozegnanie';
const ONB_GOODBYE_CHANNEL_ID = 'panel_onb_pozegnanie_channel';
const ONB_GOODBYE_TOGGLE_ID = 'panel_onb_pozegnanie_toggle';
const ONB_GOODBYE_EDIT_ID = 'panel_onb_pozegnanie_edit';
const ONB_GOODBYE_EDIT_MODAL_ID = 'panel_onb_pozegnanie_edit_modal';
const ONB_ROLE_OPEN_ID = 'panel_onb_rola';
const ONB_ROLE_SELECT_ID = 'panel_onb_rola_select';
const ONB_ROLE_TOGGLE_ID = 'panel_onb_rola_toggle';

// Kategorie na ekranie głównym. `key` trafia do PANEL_CATEGORY_PREFIX + key.
// `ready: false` = pokazuje ekran "wkrótce" zamiast prawdziwej zawartości
// (na razie tylko 'onboarding' jest w pełni podłączone).
const CATEGORIES = [
  { key: 'onboarding', label: 'Powitania i pożegnania', icon: '👋', ready: true },
  { key: 'regulamin', label: 'Regulamin', icon: '📜', ready: false },
  { key: 'tickety', label: 'Tickety', icon: '🎫', ready: false },
  { key: 'poziomy', label: 'Poziomy i XP', icon: '🏆', ready: false },
  { key: 'role-panele', label: 'Panele ról', icon: '🎨', ready: false },
  { key: 'propozycje', label: 'Propozycje', icon: '💡', ready: false },
];

function statusBadge(enabled) {
  return enabled ? '🟢 włączone' : '⚪ wyłączone';
}

// ============================================================
// EKRAN GŁÓWNY
// ============================================================

function buildHomeContainer() {
  const container = new ContainerBuilder().setAccentColor(0x5865f2);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('## ⚙️ Panel konfiguracji serwera'),
    new TextDisplayBuilder().setContent('Wybierz kategorię, którą chcesz skonfigurować.'),
  );

  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

  // Kategorie po 2 w rzędzie (max 5 przycisków/rząd, ale trzymamy 2 dla czytelności)
  for (let i = 0; i < CATEGORIES.length; i += 2) {
    const pair = CATEGORIES.slice(i, i + 2);
    const row = new ActionRowBuilder().addComponents(
      pair.map(cat =>
        new ButtonBuilder()
          .setCustomId(`${PANEL_CATEGORY_PREFIX}${cat.key}`)
          .setLabel(cat.label)
          .setEmoji(cat.icon)
          .setStyle(ButtonStyle.Secondary),
      ),
    );
    container.addActionRowComponents(row);
  }

  return container;
}

function buildComingSoonContainer(category) {
  const container = new ContainerBuilder().setAccentColor(0x5865f2);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${category.icon} ${category.label}`),
    new TextDisplayBuilder().setContent(
      '🚧 Ta sekcja panelu jeszcze nie jest gotowa — na razie skonfigurujesz to przez dedykowane komendy `/setup-*`.',
    ),
  );

  container.addActionRowComponents(buildBackRow(PANEL_HOME_ID, 'Wróć do menu głównego'));
  return container;
}

function buildBackRow(customId, label) {
  const button = new ButtonBuilder().setCustomId(customId).setLabel(label).setEmoji('⬅️').setStyle(ButtonStyle.Secondary);
  return new ActionRowBuilder().addComponents(button);
}

// ============================================================
// KATEGORIA: ONBOARDING (podmenu)
// ============================================================

function buildOnboardingMenuContainer(config) {
  const container = new ContainerBuilder().setAccentColor(0x5865f2);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('## 👋 Powitania i pożegnania'),
    new TextDisplayBuilder().setContent('Wybierz co chcesz skonfigurować.'),
  );

  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

  const welcomeStatus = config?.welcome_channel_id ? statusBadge(true) : statusBadge(false);
  const goodbyeStatus = config?.goodbye_channel_id ? statusBadge(true) : statusBadge(false);
  const roleStatus = config?.starter_role_id ? statusBadge(true) : statusBadge(false);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `-# Powitania: ${welcomeStatus} · Pożegnania: ${goodbyeStatus} · Rola startowa: ${roleStatus}`,
    ),
  );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(ONB_WELCOME_OPEN_ID).setLabel('Powitania').setEmoji('👋').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(ONB_GOODBYE_OPEN_ID).setLabel('Pożegnania').setEmoji('👋').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(ONB_ROLE_OPEN_ID).setLabel('Rola startowa').setEmoji('🎭').setStyle(ButtonStyle.Primary),
  );
  container.addActionRowComponents(row);

  container.addActionRowComponents(buildBackRow(PANEL_HOME_ID, 'Wróć do menu głównego'));

  return container;
}

// ============================================================
// SZCZEGÓŁY: POWITANIA
// ============================================================

function buildWelcomeDetailContainer(guild, config) {
  const container = new ContainerBuilder().setAccentColor(0x57f287);
  const enabled = Boolean(config?.welcome_channel_id);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('## 👋 Powitania'),
    new TextDisplayBuilder().setContent(
      `Status: **${statusBadge(enabled)}**\n` +
      (config?.welcome_message
        ? `Treść: własna (zmień przez "Edytuj treść")`
        : `Treść: domyślna`),
    ),
  );

  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId(ONB_WELCOME_CHANNEL_ID)
    .setPlaceholder('Wybierz kanał na powitania...')
    .addChannelTypes(ChannelType.GuildText);
  if (config?.welcome_channel_id) channelSelect.setDefaultChannels(config.welcome_channel_id);

  container.addActionRowComponents(new ActionRowBuilder().addComponents(channelSelect));

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(ONB_WELCOME_EDIT_ID).setLabel('Edytuj treść').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(ONB_WELCOME_TOGGLE_ID)
      .setLabel(enabled ? 'Wyłącz' : 'Włącz')
      .setEmoji(enabled ? '🔴' : '🟢')
      .setStyle(enabled ? ButtonStyle.Danger : ButtonStyle.Success)
      .setDisabled(!enabled),
  );
  container.addActionRowComponents(actionRow);

  container.addActionRowComponents(buildBackRow(ONB_BACK_ID, 'Wróć'));

  return container;
}

function buildWelcomeEditModal(config) {
  const modal = new ModalBuilder().setCustomId(ONB_WELCOME_EDIT_MODAL_ID).setTitle('Treść powitania');

  const input = new TextInputBuilder()
    .setCustomId('message')
    .setLabel('Treść (puste = domyślna)')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('{user} {username} {server} {membercount}')
    .setMaxLength(1500)
    .setValue(config?.welcome_message || '')
    .setRequired(false);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

// ============================================================
// SZCZEGÓŁY: POŻEGNANIA
// ============================================================

function buildGoodbyeDetailContainer(guild, config) {
  const container = new ContainerBuilder().setAccentColor(0xed4245);
  const enabled = Boolean(config?.goodbye_channel_id);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('## 👋 Pożegnania'),
    new TextDisplayBuilder().setContent(
      `Status: **${statusBadge(enabled)}**\n` +
      (config?.goodbye_message ? `Treść: własna (zmień przez "Edytuj treść")` : `Treść: domyślna`),
    ),
  );

  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId(ONB_GOODBYE_CHANNEL_ID)
    .setPlaceholder('Wybierz kanał na pożegnania...')
    .addChannelTypes(ChannelType.GuildText);
  if (config?.goodbye_channel_id) channelSelect.setDefaultChannels(config.goodbye_channel_id);

  container.addActionRowComponents(new ActionRowBuilder().addComponents(channelSelect));

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(ONB_GOODBYE_EDIT_ID).setLabel('Edytuj treść').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(ONB_GOODBYE_TOGGLE_ID)
      .setLabel(enabled ? 'Wyłącz' : 'Włącz')
      .setEmoji(enabled ? '🔴' : '🟢')
      .setStyle(enabled ? ButtonStyle.Danger : ButtonStyle.Success)
      .setDisabled(!enabled),
  );
  container.addActionRowComponents(actionRow);

  container.addActionRowComponents(buildBackRow(ONB_BACK_ID, 'Wróć'));

  return container;
}

function buildGoodbyeEditModal(config) {
  const modal = new ModalBuilder().setCustomId(ONB_GOODBYE_EDIT_MODAL_ID).setTitle('Treść pożegnania');

  const input = new TextInputBuilder()
    .setCustomId('message')
    .setLabel('Treść (puste = domyślna)')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('{username} {tag} {server} {membercount}')
    .setMaxLength(1500)
    .setValue(config?.goodbye_message || '')
    .setRequired(false);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

// ============================================================
// SZCZEGÓŁY: ROLA STARTOWA
// ============================================================

function buildStarterRoleDetailContainer(guild, config) {
  const container = new ContainerBuilder().setAccentColor(0x9b59b6);
  const enabled = Boolean(config?.starter_role_id);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('## 🎭 Rola startowa'),
    new TextDisplayBuilder().setContent(
      `Status: **${statusBadge(enabled)}**\n` +
      `Zastępowana przy weryfikacji: **${config?.starter_role_replace_on_verify ? 'Tak' : 'Nie'}**`,
    ),
  );

  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

  const roleSelect = new RoleSelectMenuBuilder().setCustomId(ONB_ROLE_SELECT_ID).setPlaceholder('Wybierz rolę startową...');
  if (config?.starter_role_id) roleSelect.setDefaultRoles(config.starter_role_id);

  container.addActionRowComponents(new ActionRowBuilder().addComponents(roleSelect));

  const toggleButton = new ButtonBuilder()
    .setCustomId(ONB_ROLE_TOGGLE_ID)
    .setLabel(config?.starter_role_replace_on_verify ? 'Nie zastępuj przy weryfikacji' : 'Zastępuj przy weryfikacji')
    .setEmoji('🔁')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(!enabled);

  container.addActionRowComponents(new ActionRowBuilder().addComponents(toggleButton));
  container.addActionRowComponents(buildBackRow(ONB_BACK_ID, 'Wróć'));

  return container;
}

// ============================================================
// HANDLERY
// ============================================================

// Bezpieczne "odśwież tę samą wiadomość" - działa zarówno dla przycisków/select menu
// (zawsze mają .update()) jak i dla modali (mają .update() TYLKO gdy modal został otwarty
// z komponentu na wiadomości - .isFromMessage() to sprawdza).
async function safeUpdate(interaction, payload) {
  if (typeof interaction.isFromMessage === 'function' && !interaction.isFromMessage()) {
    await interaction.reply({ ...payload, flags: (payload.flags ?? 0) | MessageFlags.Ephemeral });
    return;
  }
  await interaction.update(payload);
}

// --- Otwarcie panelu (komenda /panel) ---
async function handleOpenPanel(interaction) {
  const container = buildHomeContainer();
  await interaction.reply({ components: [container], flags: MessageFlags.Ephemeral | V2_FLAGS });
}

// --- Powrót do ekranu głównego ---
async function handlePanelHomeClick(interaction) {
  const container = buildHomeContainer();
  await safeUpdate(interaction, { components: [container], flags: V2_FLAGS });
}

// --- Kliknięcie kategorii na ekranie głównym ---
async function handleCategoryClick(interaction) {
  const key = interaction.customId.slice(PANEL_CATEGORY_PREFIX.length);
  const category = CATEGORIES.find(c => c.key === key);

  if (!category) {
    await safeUpdate(interaction, { components: [buildHomeContainer()], flags: V2_FLAGS });
    return;
  }

  if (!category.ready) {
    await safeUpdate(interaction, { components: [buildComingSoonContainer(category)], flags: V2_FLAGS });
    return;
  }

  const config = await db.getGuildConfig(interaction.guild.id);
  await safeUpdate(interaction, { components: [buildOnboardingMenuContainer(config)], flags: V2_FLAGS });
}

// --- Powrót do podmenu Onboarding ---
async function handleOnboardingBack(interaction) {
  const config = await db.getGuildConfig(interaction.guild.id);
  await safeUpdate(interaction, { components: [buildOnboardingMenuContainer(config)], flags: V2_FLAGS });
}

// --- Otwarcie szczegółów: Powitania ---
async function handleWelcomeOpen(interaction) {
  const config = await db.getGuildConfig(interaction.guild.id);
  await safeUpdate(interaction, { components: [buildWelcomeDetailContainer(interaction.guild, config)], flags: V2_FLAGS });
}

// --- Wybór kanału powitań (Channel Select) ---
async function handleWelcomeChannelSelect(interaction) {
  const channelId = interaction.values[0];
  await db.setWelcomeConfig(interaction.guild.id, { channelId, message: undefined });
  const config = await db.getGuildConfig(interaction.guild.id);
  await safeUpdate(interaction, { components: [buildWelcomeDetailContainer(interaction.guild, config)], flags: V2_FLAGS });
}

// --- Wyłączenie powitań (kanał -> null, treść zostaje zapisana na później) ---
async function handleWelcomeToggle(interaction) {
  await db.setWelcomeConfig(interaction.guild.id, { channelId: null, message: undefined });
  const config = await db.getGuildConfig(interaction.guild.id);
  await safeUpdate(interaction, { components: [buildWelcomeDetailContainer(interaction.guild, config)], flags: V2_FLAGS });
}

// --- Otwarcie modala edycji treści powitania ---
async function handleWelcomeEditClick(interaction) {
  const config = await db.getGuildConfig(interaction.guild.id);
  await interaction.showModal(buildWelcomeEditModal(config));
}

// --- Zapis treści powitania z modala - edytuje TĘ SAMĄ wiadomość panelu ---
async function handleWelcomeEditModalSubmit(interaction) {
  const guildId = interaction.guild.id;
  const value = interaction.fields.getTextInputValue('message');
  const existing = await db.getGuildConfig(guildId);

  await db.setWelcomeConfig(guildId, {
    channelId: existing?.welcome_channel_id ?? null,
    message: value || null,
  });

  const config = await db.getGuildConfig(guildId);
  await safeUpdate(interaction, { components: [buildWelcomeDetailContainer(interaction.guild, config)], flags: V2_FLAGS });
}

// --- Otwarcie szczegółów: Pożegnania ---
async function handleGoodbyeOpen(interaction) {
  const config = await db.getGuildConfig(interaction.guild.id);
  await safeUpdate(interaction, { components: [buildGoodbyeDetailContainer(interaction.guild, config)], flags: V2_FLAGS });
}

async function handleGoodbyeChannelSelect(interaction) {
  const channelId = interaction.values[0];
  await db.setGoodbyeConfig(interaction.guild.id, { channelId, message: undefined });
  const config = await db.getGuildConfig(interaction.guild.id);
  await safeUpdate(interaction, { components: [buildGoodbyeDetailContainer(interaction.guild, config)], flags: V2_FLAGS });
}

async function handleGoodbyeToggle(interaction) {
  await db.setGoodbyeConfig(interaction.guild.id, { channelId: null, message: undefined });
  const config = await db.getGuildConfig(interaction.guild.id);
  await safeUpdate(interaction, { components: [buildGoodbyeDetailContainer(interaction.guild, config)], flags: V2_FLAGS });
}

async function handleGoodbyeEditClick(interaction) {
  const config = await db.getGuildConfig(interaction.guild.id);
  await interaction.showModal(buildGoodbyeEditModal(config));
}

async function handleGoodbyeEditModalSubmit(interaction) {
  const guildId = interaction.guild.id;
  const value = interaction.fields.getTextInputValue('message');
  const existing = await db.getGuildConfig(guildId);

  await db.setGoodbyeConfig(guildId, {
    channelId: existing?.goodbye_channel_id ?? null,
    message: value || null,
  });

  const config = await db.getGuildConfig(guildId);
  await safeUpdate(interaction, { components: [buildGoodbyeDetailContainer(interaction.guild, config)], flags: V2_FLAGS });
}

// --- Otwarcie szczegółów: Rola startowa ---
async function handleStarterRoleOpen(interaction) {
  const config = await db.getGuildConfig(interaction.guild.id);
  await safeUpdate(interaction, { components: [buildStarterRoleDetailContainer(interaction.guild, config)], flags: V2_FLAGS });
}

async function handleStarterRoleSelect(interaction) {
  const roleId = interaction.values[0];
  const guild = interaction.guild;
  const role = guild.roles.cache.get(roleId) || (await guild.roles.fetch(roleId).catch(() => null));
  const botMember = guild.members.me;

  if (role?.managed) {
    const config = await db.getGuildConfig(guild.id);
    await safeUpdate(interaction, {
      components: [buildStarterRoleDetailContainer(guild, config)],
      flags: V2_FLAGS,
    });
    await interaction.followUp({
      content: '❌ Nie można ustawić roli zarządzanej przez integrację/bota jako roli startowej.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (botMember && role && role.position >= botMember.roles.highest.position) {
    const config = await db.getGuildConfig(guild.id);
    await safeUpdate(interaction, {
      components: [buildStarterRoleDetailContainer(guild, config)],
      flags: V2_FLAGS,
    });
    await interaction.followUp({
      content: '⚠️ Ta rola jest wyżej (lub na równi) w hierarchii niż rola bota — bot nie będzie w stanie jej nadawać.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await db.setStarterRoleConfig(guild.id, { roleId, replaceOnVerify: undefined });
  const config = await db.getGuildConfig(guild.id);
  await safeUpdate(interaction, { components: [buildStarterRoleDetailContainer(guild, config)], flags: V2_FLAGS });
}

async function handleStarterRoleToggle(interaction) {
  const guildId = interaction.guild.id;
  const existing = await db.getGuildConfig(guildId);

  await db.setStarterRoleConfig(guildId, {
    roleId: existing?.starter_role_id ?? null,
    replaceOnVerify: !existing?.starter_role_replace_on_verify,
  });

  const config = await db.getGuildConfig(guildId);
  await safeUpdate(interaction, { components: [buildStarterRoleDetailContainer(interaction.guild, config)], flags: V2_FLAGS });
}

module.exports = {
  V2_FLAGS,
  PANEL_HOME_ID,
  PANEL_CATEGORY_PREFIX,
  CATEGORIES,
  ONB_BACK_ID,
  ONB_WELCOME_OPEN_ID,
  ONB_WELCOME_CHANNEL_ID,
  ONB_WELCOME_TOGGLE_ID,
  ONB_WELCOME_EDIT_ID,
  ONB_WELCOME_EDIT_MODAL_ID,
  ONB_GOODBYE_OPEN_ID,
  ONB_GOODBYE_CHANNEL_ID,
  ONB_GOODBYE_TOGGLE_ID,
  ONB_GOODBYE_EDIT_ID,
  ONB_GOODBYE_EDIT_MODAL_ID,
  ONB_ROLE_OPEN_ID,
  ONB_ROLE_SELECT_ID,
  ONB_ROLE_TOGGLE_ID,
  buildHomeContainer,
  buildComingSoonContainer,
  buildOnboardingMenuContainer,
  buildWelcomeDetailContainer,
  buildWelcomeEditModal,
  buildGoodbyeDetailContainer,
  buildGoodbyeEditModal,
  buildStarterRoleDetailContainer,
  handleOpenPanel,
  handlePanelHomeClick,
  handleCategoryClick,
  handleOnboardingBack,
  handleWelcomeOpen,
  handleWelcomeChannelSelect,
  handleWelcomeToggle,
  handleWelcomeEditClick,
  handleWelcomeEditModalSubmit,
  handleGoodbyeOpen,
  handleGoodbyeChannelSelect,
  handleGoodbyeToggle,
  handleGoodbyeEditClick,
  handleGoodbyeEditModalSubmit,
  handleStarterRoleOpen,
  handleStarterRoleSelect,
  handleStarterRoleToggle,
};
