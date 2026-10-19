const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  LabelBuilder,
  TextInputBuilder,
  TextInputStyle,
  FileUploadBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
} = require('discord.js');
const db = require('../db');

const BUTTON_CUSTOM_ID_PREFIX = 'open_suggestion_modal:';
const MODAL_CUSTOM_ID_PREFIX = 'submit_suggestion_modal:';
const STYLE_MODAL_CUSTOM_ID_PREFIX = 'setup_suggestion_style_modal:';

const DEFAULT_PROMPT_TEXT =
  '📋 **Zgłoś swoją propozycję!**\n' +
  'Kliknij przycisk poniżej, żeby dodać tytuł, opis i zdjęcie (z dysku albo linkiem).\n' +
  'Propozycja pojawi się na kanale listy, gdzie reszta serwera zagłosuje reakcjami.';
const DEFAULT_BUTTON_LABEL = 'Dodaj propozycję';
const DEFAULT_UPVOTE_EMOJI = '✅';
const DEFAULT_DOWNVOTE_EMOJI = '❌';

// Tymczasowe przechowywanie danych z /setup-propozycje
const pendingSetups = new Map();

function storePendingSetup(token, data) {
  pendingSetups.set(token, data);
  const timer = setTimeout(() => pendingSetups.delete(token), 10 * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
}

function takePendingSetup(token) {
  const data = pendingSetups.get(token);
  pendingSetups.delete(token);
  return data;
}

function toReactableEmoji(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  const customMatch = trimmed.match(/^<a?:(\w+):(\d+)>$/);
  if (customMatch) {
    const [, name, id] = customMatch;
    return `${name}:${id}`;
  }
  return trimmed;
}

function buildPromptMessage(board) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${BUTTON_CUSTOM_ID_PREFIX}${board.id}`)
      .setLabel((board.button_label || DEFAULT_BUTTON_LABEL).slice(0, 80))
      .setEmoji('📝')
      .setStyle(ButtonStyle.Primary),
  );

  return {
    content: board.prompt_text || DEFAULT_PROMPT_TEXT,
    components: [row],
  };
}

function buildModal(boardId) {
  const modal = new ModalBuilder()
    .setCustomId(`${MODAL_CUSTOM_ID_PREFIX}${boardId}`)
    .setTitle('Nowa propozycja');

  const titleLabel = new LabelBuilder()
    .setLabel('Tytuł')
    .setTextInputComponent(
      new TextInputBuilder()
        .setCustomId('sugg_title')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(100)
        .setRequired(true),
    );

  const descLabel = new LabelBuilder()
    .setLabel('Opis propozycji')
    .setTextInputComponent(
      new TextInputBuilder()
        .setCustomId('sugg_desc')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(1000)
        .setRequired(true),
    );

  const imageUploadLabel = new LabelBuilder()
    .setLabel('Zdjęcie z dysku (opcjonalnie)')
    .setDescription('Wgraj plik z komputera/telefonu - albo pomiń i wklej link poniżej')
    .setFileUploadComponent(
      new FileUploadBuilder()
        .setCustomId('sugg_image_upload')
        .setMaxValues(1)
        .setRequired(false),
    );

  const imageLinkLabel = new LabelBuilder()
    .setLabel('Albo: link do zdjęcia (opcjonalnie)')
    .setDescription('Pomiń, jeśli wgrałeś zdjęcie powyżej')
    .setTextInputComponent(
      new TextInputBuilder()
        .setCustomId('sugg_image_link')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('https://...')
        .setRequired(false),
    );

  modal.addLabelComponents(titleLabel, descLabel, imageUploadLabel, imageLinkLabel);

  return modal;
}

function buildStyleModal(token) {
  const modal = new ModalBuilder()
    .setCustomId(`${STYLE_MODAL_CUSTOM_ID_PREFIX}${token}`)
    .setTitle('Własny styl tablicy propozycji');

  const promptLabel = new LabelBuilder()
    .setLabel('Treść wiadomości z przyciskiem')
    .setDescription('To zobaczą użytkownicy na kanale tworzenia propozycji')
    .setTextInputComponent(
      new TextInputBuilder()
        .setCustomId('prompt_text')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(1900)
        .setRequired(true)
        .setValue(DEFAULT_PROMPT_TEXT),
    );

  const buttonLabelField = new LabelBuilder()
    .setLabel('Tekst na przycisku')
    .setTextInputComponent(
      new TextInputBuilder()
        .setCustomId('button_label')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(80)
        .setRequired(true)
        .setValue(DEFAULT_BUTTON_LABEL),
    );

  modal.addLabelComponents(promptLabel, buttonLabelField);

  return modal;
}

function isValidHttpUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function extractFirstUploadUrl(fieldsResult) {
  if (!fieldsResult) return null;
  if (Array.isArray(fieldsResult)) {
    return fieldsResult[0]?.url ?? null;
  }
  if (typeof fieldsResult.first === 'function') {
    return fieldsResult.first()?.url ?? null;
  }
  return null;
}

async function createSuggestionBoard(
  interaction,
  { categoryId, listName, createName, promptText, buttonLabel, upvoteEmoji, downvoteEmoji },
) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true });
  }

  const guild = interaction.guild;

  try {
    const everyoneRole = guild.roles.everyone;
    const botMember = guild.members.me;

    const lockedOverwrites = [
      {
        id: everyoneRole.id,
        deny: [
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.AddReactions,
          PermissionFlagsBits.CreatePublicThreads,
          PermissionFlagsBits.CreatePrivateThreads,
        ],
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
      },
      {
        id: botMember.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.AddReactions,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageMessages,
        ],
      },
    ];

    const listChannel = await guild.channels.create({
      name: listName,
      type: 0,
      parent: categoryId ?? null,
      topic: 'Tutaj lądują zgłoszone propozycje. Głosuj reakcjami.',
      permissionOverwrites: lockedOverwrites,
      reason: `Kanał listy propozycji skonfigurowany przez ${interaction.user.tag}`,
    });

    const createChannel = await guild.channels.create({
      name: createName,
      type: 0,
      parent: categoryId ?? null,
      topic: 'Kliknij przycisk poniżej, żeby zgłosić nową propozycję.',
      permissionOverwrites: lockedOverwrites,
      reason: `Kanał tworzenia propozycji skonfigurowany przez ${interaction.user.tag}`,
    });

    // Wprowadzono await do tworzenia w bazie PostgreSQL
    const board = await db.createSuggestionBoard(guild.id, {
      listChannelId: listChannel.id,
      createChannelId: createChannel.id,
      promptText,
      buttonLabel,
      upvoteEmoji,
      downvoteEmoji,
    });

    const { content, components } = buildPromptMessage(board);
    const promptMsg = await createChannel.send({ content, components });
    
    // Wprowadzono await
    await db.setSuggestionBoardPromptMessageId(board.id, promptMsg.id);

    await interaction.editReply({
      content:
        `✅ Gotowe! Nowa tablica propozycji **#${board.id}**\n` +
        `📋 Lista propozycji: <#${listChannel.id}>\n` +
        `📝 Tworzenie propozycji: <#${createChannel.id}>\n` +
        `🗳️ Głosowanie: ${board.upvote_emoji || DEFAULT_UPVOTE_EMOJI} / ${board.downvote_emoji || DEFAULT_DOWNVOTE_EMOJI}\n\n` +
        `Nikt (poza botem) nie może pisać ani dodawać własnych reakcji na tych kanałach — jedyny sposób ` +
        `na zgłoszenie propozycji to przycisk.\n` +
        `Możesz odpalić \`/setup-propozycje\` ponownie, żeby stworzyć kolejną, niezależną tablicę propozycji.`,
    });
  } catch (err) {
    console.error(err);
    await interaction.editReply({
      content:
        '❌ Nie udało się utworzyć kanałów. Sprawdź, czy bot ma uprawnienia **Zarządzaj kanałami** ' +
        'i **Zarządzaj rolami** (potrzebne do ustawienia blokad pisania). Jeśli podałeś/aś custom emotkę, ' +
        'sprawdź też czy bot ma dostęp do serwera, z którego ona pochodzi.',
    }).catch(() => null);
  }
}

async function handleStyleModalSubmit(interaction) {
  const token = interaction.customId.slice(STYLE_MODAL_CUSTOM_ID_PREFIX.length);
  const pending = takePendingSetup(token);

  if (!pending) {
    await interaction.reply({
      content: '⚠️ Ta sesja konfiguracji wygasła (limit 10 minut). Uruchom `/setup-propozycje` jeszcze raz.',
      ephemeral: true,
    });
    return;
  }

  const promptText = interaction.fields.getTextInputValue('prompt_text');
  const buttonLabel = interaction.fields.getTextInputValue('button_label');

  await createSuggestionBoard(interaction, { ...pending, promptText, buttonLabel });
}

async function handleModalSubmit(interaction) {
  // Bezpieczne konwertowanie na cyfrę z zabezpieczeniem NaN
  const rawId = interaction.customId.slice(MODAL_CUSTOM_ID_PREFIX.length);
  const boardId = parseInt(rawId, 10);

  if (isNaN(boardId)) {
    await interaction.reply({
      content: '⚠️ Błędny identyfikator tablicy propozycji.',
      ephemeral: true,
    });
    return;
  }

  // Wprowadzono await
  const board = await db.getSuggestionBoard(boardId);

  if (!board) {
    await interaction.reply({
      content: '⚠️ Ta tablica propozycji już nie istnieje. Poproś administratora o ponowne `/setup-propozycje`.',
      ephemeral: true,
    });
    return;
  }

  const listChannel = await interaction.guild.channels.fetch(board.list_channel_id).catch(() => null);
  if (!listChannel || !listChannel.isTextBased()) {
    await interaction.reply({
      content: '⚠️ Nie znaleziono kanału listy propozycji. Poproś administratora o ponowne uruchomienie `/setup-propozycje`.',
      ephemeral: true,
    });
    return;
  }

  const title = interaction.fields.getTextInputValue('sugg_title');
  const description = interaction.fields.getTextInputValue('sugg_desc');
  const imageLink = interaction.fields.getTextInputValue('sugg_image_link');

  let uploadedFiles = null;
  try {
    uploadedFiles = interaction.fields.getUploadedFiles('sugg_image_upload');
  } catch {
    uploadedFiles = null;
  }

  const uploadedUrl = extractFirstUploadUrl(uploadedFiles);
  const imageUrl = uploadedUrl ?? (isValidHttpUrl(imageLink) ? imageLink : null);

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(0x57f287)
    .setFooter({
      text: `Zgłoszone przez ${interaction.user.tag}`,
      iconURL: interaction.user.displayAvatarURL(),
    })
    .setTimestamp();

  if (imageUrl) {
    embed.setImage(imageUrl);
  }

  const posted = await listChannel.send({ embeds: [embed] }).catch(() => null);

  if (!posted) {
    await interaction.reply({
      content: '❌ Nie udało się opublikować propozycji. Sprawdź, czy bot ma uprawnienia na kanale listy propozycji.',
      ephemeral: true,
    });
    return;
  }

  const upvote = toReactableEmoji(board.upvote_emoji) ?? DEFAULT_UPVOTE_EMOJI;
  const downvote = toReactableEmoji(board.downvote_emoji) ?? DEFAULT_DOWNVOTE_EMOJI;

  const upvoteOk = await posted.react(upvote).catch(() => null);
  const downvoteOk = await posted.react(downvote).catch(() => null);

  let warning = '';
  if (!upvoteOk || !downvoteOk) {
    warning =
      '\n⚠️ Nie udało się dodać jednej z ustawionych emotek do głosowania (może zostać usunięta z serwera) - ' +
      'dodaj reakcję ręcznie albo popraw ustawienia tablicy.';
  }

  await interaction.reply({
    content: `✅ Twoja propozycja została dodana na <#${listChannel.id}>!${warning}`,
    ephemeral: true,
  });
}

module.exports = {
  BUTTON_CUSTOM_ID_PREFIX,
  MODAL_CUSTOM_ID_PREFIX,
  STYLE_MODAL_CUSTOM_ID_PREFIX,
  DEFAULT_UPVOTE_EMOJI,
  DEFAULT_DOWNVOTE_EMOJI,
  buildPromptMessage,
  buildModal,
  buildStyleModal,
  storePendingSetup,
  createSuggestionBoard,
  handleStyleModalSubmit,
  handleModalSubmit,
};
