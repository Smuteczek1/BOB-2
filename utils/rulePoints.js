const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  MessageFlags,
} = require('discord.js');
const db = require('../db');

const RULE_POINT_EDIT_SELECT_ID = 'rule_point_edit_select';
const RULE_POINT_DELETE_SELECT_ID = 'rule_point_delete_select';
const RULE_POINT_ADD_MODAL_ID = 'rule_point_add_modal';
const RULE_POINT_EDIT_MODAL_PREFIX = 'rule_point_edit_modal_';

// --- Budowanie okna (modala) do dodawania nowego punktu ---
function buildAddModal() {
  const modal = new ModalBuilder()
    .setCustomId(RULE_POINT_ADD_MODAL_ID)
    .setTitle('Nowy punkt regulaminu');

  const titleInput = new TextInputBuilder()
    .setCustomId('title')
    .setLabel('Tytuł punktu (np. Szanujemy się)')
    .setStyle(TextInputStyle.Short)
    .setMaxLength(100)
    .setRequired(true);

  const summaryInput = new TextInputBuilder()
    .setCustomId('summary')
    .setLabel('Krótki opis (widoczny od razu)')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(1000)
    .setRequired(true);

  const detailsInput = new TextInputBuilder()
    .setCustomId('details')
    .setLabel('Rozwinięcie (po "Rozwiń") - opcjonalne')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(1500)
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(titleInput),
    new ActionRowBuilder().addComponents(summaryInput),
    new ActionRowBuilder().addComponents(detailsInput),
  );

  return modal;
}

// --- Budowanie okna (modala) do edycji istniejącego punktu, wypełnionego aktualną treścią ---
function buildEditModal(point) {
  const modal = new ModalBuilder()
    .setCustomId(`${RULE_POINT_EDIT_MODAL_PREFIX}${point.id}`)
    .setTitle(`Edytuj: ${point.title}`.slice(0, 45));

  const titleInput = new TextInputBuilder()
    .setCustomId('title')
    .setLabel('Tytuł punktu')
    .setStyle(TextInputStyle.Short)
    .setMaxLength(100)
    .setValue(point.title)
    .setRequired(true);

  const summaryInput = new TextInputBuilder()
    .setCustomId('summary')
    .setLabel('Krótki opis (widoczny od razu)')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(1000)
    .setValue(point.summary)
    .setRequired(true);

  const detailsInput = new TextInputBuilder()
    .setCustomId('details')
    .setLabel('Rozwinięcie (opcjonalne)')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(1500)
    .setValue(point.details || '')
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(titleInput),
    new ActionRowBuilder().addComponents(summaryInput),
    new ActionRowBuilder().addComponents(detailsInput),
  );

  return modal;
}

// --- Budowanie select menu z listą punktów (do edycji lub usuwania) ---
async function buildPointSelectMenu(guildId, customId, placeholder) {
  const points = await db.getRulePoints(guildId);
  if (!points || points.length === 0) return null;

  const options = points.slice(0, 25).map((p, idx) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(`${idx + 1}. ${p.title}`.slice(0, 100))
      .setDescription((p.summary || '').slice(0, 90))
      .setValue(String(p.id)),
  );

  const select = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .addOptions(options);

  return new ActionRowBuilder().addComponents(select);
}

// --- Handlery interakcji ---

async function handleRulePointEditSelect(interaction) {
  const id = interaction.values[0];
  const point = await db.getRulePoint(id);

  if (!point) {
    await interaction.update({ content: '⚠️ Ten punkt już nie istnieje.', components: [] });
    return;
  }

  await interaction.showModal(buildEditModal(point));
}

async function handleRulePointDeleteSelect(interaction) {
  const id = interaction.values[0];
  const point = await db.deleteRulePoint(id);

  if (!point) {
    await interaction.update({ content: '⚠️ Ten punkt już nie istnieje.', components: [] });
    return;
  }

  // Jeśli punkt był już opublikowany na kanale - usuwamy też jego wiadomość
  if (point.message_id) {
    const config = await db.getGuildConfig(point.guild_id);
    if (config?.verify_channel_id) {
      const channel = await interaction.guild.channels.fetch(config.verify_channel_id).catch(() => null);
      if (channel) {
        const msg = await channel.messages.fetch(point.message_id).catch(() => null);
        if (msg) await msg.delete().catch(() => null);
      }
    }
  }

  await interaction.update({
    content:
      `🗑️ Usunięto punkt **${point.title}**.\n` +
      `ℹ️ Numeracja pozostałych punktów na kanale może się rozjechać — użyj \`/setup-regulamin publikuj\`, żeby odświeżyć całość.`,
    components: [],
  });
}

async function handleRulePointAddModalSubmit(interaction) {
  const title = interaction.fields.getTextInputValue('title');
  const summary = interaction.fields.getTextInputValue('summary');
  const details = interaction.fields.getTextInputValue('details') || null;

  await db.addRulePoint(interaction.guild.id, { title, summary, details });

  await interaction.reply({
    content:
      `✅ Dodano punkt regulaminu **${title}**!\n` +
      `Użyj \`/setup-regulamin publikuj\`, aby opublikować/zaktualizować regulamin na kanale.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleRulePointEditModalSubmit(interaction) {
  const id = interaction.customId.slice(RULE_POINT_EDIT_MODAL_PREFIX.length);
  const title = interaction.fields.getTextInputValue('title');
  const summary = interaction.fields.getTextInputValue('summary');
  const details = interaction.fields.getTextInputValue('details') || null;

  await db.updateRulePoint(id, { title, summary, details });

  // Punkty nie są już publikowane jako osobne wiadomości - prywatny widok regulaminu
  // buduje się od nowa przy każdym otwarciu, więc edycja od razu jest widoczna,
  // bez potrzeby ręcznego odświeżania czegokolwiek na kanale.
  await interaction.reply({
    content: `✅ Zaktualizowano punkt **${title}**.`,
    flags: MessageFlags.Ephemeral,
  });
}

module.exports = {
  RULE_POINT_EDIT_SELECT_ID,
  RULE_POINT_DELETE_SELECT_ID,
  RULE_POINT_ADD_MODAL_ID,
  RULE_POINT_EDIT_MODAL_PREFIX,
  buildAddModal,
  buildEditModal,
  buildPointSelectMenu,
  handleRulePointEditSelect,
  handleRulePointDeleteSelect,
  handleRulePointAddModalSubmit,
  handleRulePointEditModalSubmit,
};
