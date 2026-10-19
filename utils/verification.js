const {
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');
const db = require('../db');

const RULE_PRIVATE_OPEN_ID = 'rule_private_open';
const RULE_PRIVATE_EXPAND_PREFIX = 'rule_private_expand_';
const RULE_ACCEPT_ID = 'rule_accept';

// Flaga wymagana dla KAŻDEJ wiadomości używającej Components V2 (Container/Section/TextDisplay/...)
const V2_FLAGS = MessageFlags.IsComponentsV2;

// --- Automatyczny podział długiego regulaminu na kilka wiadomości ---
// Discord (Components V2) pozwala na max 40 komponentów w JEDNEJ wiadomości.
// Zamiast paginacji przyciskami, sami liczymy ile punktów regulaminu (z ewentualnym
// "doprecyzowaniem") zmieści się w jednej wiadomości, i jeśli zabraknie miejsca,
// automatycznie wysyłamy kolejną (osobną) wiadomość - wszystko nadal jedno pod drugim.
const MAX_COMPONENTS_PER_MESSAGE = 40;
const BASE_OVERHEAD = 4; // tytuł (+ ewentualnie opis na pierwszej wiadomości) + separator
const ACCEPT_SECTION_OVERHEAD = 8; // tytuł+tekst akceptacji + przycisk/komentarz + separator
const SAFETY_MARGIN = 3; // mały zapas na wszelki wypadek
// Budżet komponentów dostępny na same punkty w jednej wiadomości.
// Rezerwujemy miejsce na sekcję akceptacji w KAŻDEJ wiadomości (nie tylko ostatniej),
// bo dopóki nie policzymy wszystkich punktów, nie wiemy, która wiadomość okaże się ostatnia.
const POINTS_BUDGET_PER_MESSAGE =
  MAX_COMPONENTS_PER_MESSAGE - BASE_OVERHEAD - ACCEPT_SECTION_OVERHEAD - SAFETY_MARGIN;

// Ile komponentów "kosztuje" jeden punkt regulaminu w drzewie Components V2.
function pointComponentCost(point) {
  // Z doprecyzowaniem: Section + TextDisplay + Button + Separator = 4
  // Bez doprecyzowania: TextDisplay + Separator = 2
  return point.details ? 4 : 2;
}

// Dzieli punkty regulaminu na "porcje" (chunks), tak by każda porcja zmieściła się
// bezpiecznie w jednej wiadomości Components V2, razem z ewentualną sekcją akceptacji.
function chunkPoints(points) {
  const chunks = [];
  let current = [];
  let currentCost = 0;

  for (const point of points) {
    const cost = pointComponentCost(point);
    if (current.length > 0 && currentCost + cost > POINTS_BUDGET_PER_MESSAGE) {
      chunks.push(current);
      current = [];
      currentCost = 0;
    }
    current.push(point);
    currentCost += cost;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  // Jeśli w ogóle nie ma punktów, zwracamy jedną pustą "porcję", żeby dało się
  // pokazać choćby samą sekcję akceptacji.
  return chunks.length > 0 ? chunks : [[]];
}

// --- Okno 1: publiczne "wejście" do regulaminu (jedyna wiadomość widoczna na kanale) ---
const DEFAULT_RULES_TITLE = '📜 Regulamin serwera';
const DEFAULT_RULES_TEXT =
  'Zanim zaczniesz korzystać z serwera, zapoznaj się z poniższymi zasadami.\n' +
  'Kliknij przycisk poniżej, aby otworzyć swój prywatny widok regulaminu — ' +
  'na dole znajdziesz przycisk do akceptacji.';
const DEFAULT_BUTTON_LABEL = 'Sprawdź regulamin';
const DEFAULT_INTRO_COMMENT = '-# Widok otworzy się tylko dla Ciebie — nikt inny go nie zobaczy.';

// --- Okno 2: sekcja akceptacji na DOLE prywatnego widoku (pokazywana w OSTATNIEJ wiadomości) ---
const DEFAULT_ACCEPT_TITLE = 'Akceptacja regulaminu';
const DEFAULT_ACCEPT_TEXT =
  'Przeczytałeś/aś wszystkie punkty powyżej? Kliknij przycisk poniżej, aby zaakceptować ' +
  'regulamin i uzyskać dostęp do serwera.';
const DEFAULT_ACCEPT_BUTTON_LABEL = 'Akceptuję regulamin';
const DEFAULT_ACCEPT_COMMENT = '-# Klikając, potwierdzasz że zapoznałeś/aś się z powyższymi zasadami.';

// Trzyma stan "które punkty są rozwinięte" dla każdej prywatnej (ephemeral) wiadomości.
// Klucz: ID wiadomości -> Set ID punktów aktualnie rozwiniętych.
const expandedPointsByMessage = new Map();

// Trzyma informację o tym, które punkty (i jaki fragment numeracji) pokazuje
// KONKRETNA wiadomość - potrzebne, żeby po kliknięciu "Rozwiń" albo "Akceptuję"
// przebudować właśnie TĘ wiadomość, a nie cały regulamin od nowa.
// Klucz: ID wiadomości -> { pointIds: string[], startIndex: number, isLast: boolean }
const chunkMetaByMessage = new Map();

// Znacznik czasu ostatniej interakcji z daną wiadomością - używany WYŁĄCZNIE do
// sprzątania (patrz niżej), żeby powyższe dwie mapy nie rosły w nieskończoność
// przez cały czas działania bota (każde otwarcie prywatnego widoku dokładałoby wpis,
// który inaczej nigdy by nie zniknął).
const messageLastTouchedAt = new Map();

function touchMessage(messageId) {
  messageLastTouchedAt.set(messageId, Date.now());
}

// Co 30 minut usuwamy wpisy nietykane od ponad 2h - w tym czasie i tak nikt już nie
// wraca do klikania w stary, prywatny widok regulaminu.
const MAP_ENTRY_TTL_MS = 2 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [messageId, lastTouched] of messageLastTouchedAt) {
    if (now - lastTouched > MAP_ENTRY_TTL_MS) {
      messageLastTouchedAt.delete(messageId);
      expandedPointsByMessage.delete(messageId);
      chunkMetaByMessage.delete(messageId);
    }
  }
}, CLEANUP_INTERVAL_MS).unref();

function getExpandedSet(messageId) {
  touchMessage(messageId);
  if (!expandedPointsByMessage.has(messageId)) {
    expandedPointsByMessage.set(messageId, new Set());
  }
  return expandedPointsByMessage.get(messageId);
}

function memberHasVerifiedRole(member, config) {
  if (!member || !config?.verify_role_id) return false;
  return member.roles.cache.has(config.verify_role_id);
}

// --- Publiczna wiadomość: Tytuł -> Tekst -> [Przycisk] -> Komentarz ---
function buildIntroContainer(guild, config) {
  const container = new ContainerBuilder().setAccentColor(0x5865f2);

  const title = config?.verify_rules_title || DEFAULT_RULES_TITLE;
  const description = config?.verify_rules_text || DEFAULT_RULES_TEXT;
  const buttonLabel = (config?.verify_button_label || DEFAULT_BUTTON_LABEL).slice(0, 80);
  const comment = config?.verify_intro_comment || DEFAULT_INTRO_COMMENT;

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${title}`),
    new TextDisplayBuilder().setContent(description),
  );

  const button = new ButtonBuilder()
    .setCustomId(RULE_PRIVATE_OPEN_ID)
    .setLabel(buttonLabel)
    .setStyle(ButtonStyle.Primary);

  container.addActionRowComponents(new ActionRowBuilder().addComponents(button));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(comment));

  return container;
}

// --- Buduje JEDNĄ wiadomość prywatnego widoku, pokazującą tylko fragment ("porcję")
// punktów regulaminu. `isFirst` decyduje czy pokazujemy opis regulaminu na górze,
// `isLast` decyduje czy na dole doklejamy sekcję akceptacji. `startIndex` służy
// do ciągłej numeracji punktów pomiędzy wiadomościami (np. 6. i 7. w drugiej wiadomości).
function buildChunkContainer(
  guild,
  chunkPointsList,
  config,
  expandedIds,
  alreadyVerified,
  { isFirst, isLast, startIndex, multiMessage },
) {
  const container = new ContainerBuilder().setAccentColor(0x5865f2);

  const title = config?.verify_rules_title || DEFAULT_RULES_TITLE;
  const description = config?.verify_rules_text || DEFAULT_RULES_TEXT;

  if (isFirst) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${title}`),
      new TextDisplayBuilder().setContent(description),
    );
    if (multiMessage) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          '-# Regulamin jest długi, dlatego wysłałem go w kilku wiadomościach — przewiń niżej po kolejne punkty.',
        ),
      );
    }
  }

  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

  chunkPointsList.forEach((p, i) => {
    const globalIndex = startIndex + i;
    const isExpanded = expandedIds.has(String(p.id));
    let content = `### ${globalIndex + 1}. ${p.title}\n${p.summary}`;
    if (isExpanded && p.details) {
      content += `\n\n> 📖 **Doprecyzowanie:**\n> ${p.details.replaceAll('\n', '\n> ')}`;
    }

    const textDisplay = new TextDisplayBuilder().setContent(content);

    if (p.details) {
      const expandButton = new ButtonBuilder()
        .setCustomId(`${RULE_PRIVATE_EXPAND_PREFIX}${p.id}`)
        .setLabel(isExpanded ? 'Zwiń' : 'Rozwiń')
        .setEmoji(isExpanded ? '🔼' : '🔽')
        .setStyle(isExpanded ? ButtonStyle.Primary : ButtonStyle.Secondary);

      container.addSectionComponents(
        new SectionBuilder().addTextDisplayComponents(textDisplay).setButtonAccessory(expandButton),
      );
    } else {
      container.addTextDisplayComponents(textDisplay);
    }

    if (i < chunkPointsList.length - 1) {
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
    }
  });

  // --- Sekcja akceptacji: tylko w OSTATNIEJ wiadomości ---
  if (isLast) {
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large));

    const acceptTitle = config?.verify_accept_title || DEFAULT_ACCEPT_TITLE;
    const acceptText = config?.verify_accept_text || DEFAULT_ACCEPT_TEXT;
    const acceptButtonLabel = (config?.verify_accept_button_label || DEFAULT_ACCEPT_BUTTON_LABEL).slice(0, 80);
    const acceptComment = config?.verify_accept_comment || DEFAULT_ACCEPT_COMMENT;

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### ${acceptTitle}`),
      new TextDisplayBuilder().setContent(acceptText),
    );

    if (alreadyVerified) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('-# ✅ Regulamin zaakceptowany — masz już dostęp do serwera.'),
      );
    } else {
      const acceptButton = new ButtonBuilder()
        .setCustomId(RULE_ACCEPT_ID)
        .setLabel(acceptButtonLabel)
        .setStyle(ButtonStyle.Success);

      container.addActionRowComponents(new ActionRowBuilder().addComponents(acceptButton));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(acceptComment));
    }
  }

  return container;
}

// Zachowane dla kompatybilności (np. `/setup-regulamin podglad`) - buduje JEDEN,
// pełny kontener ze wszystkimi punktami naraz (bez podziału na wiadomości).
// UWAGA: przy bardzo długim regulaminie nadal może przekroczyć limit 40 komponentów -
// używane tylko do szybkiego podglądu administracyjnego, nie do właściwej weryfikacji.
function buildRegulaminContainer(guild, points, config, expandedIds = new Set(), alreadyVerified = false) {
  return buildChunkContainer(guild, points, config, expandedIds, alreadyVerified, {
    isFirst: true,
    isLast: true,
    startIndex: 0,
    multiMessage: false,
  });
}

// Kliknięcie "Sprawdź regulamin" na publicznej wiadomości - wysyła prywatny widok,
// w JEDNEJ lub KILKU wiadomościach (automatycznie, w zależności od długości regulaminu).
async function handleOpenPrivateView(interaction) {
  const guildId = interaction.guild.id;
  const config = await db.getGuildConfig(guildId);
  const points = await db.getRulePoints(guildId);

  if (!points || points.length === 0) {
    await interaction.reply({ content: 'ℹ️ Regulamin nie ma jeszcze żadnych punktów.', flags: MessageFlags.Ephemeral });
    return;
  }

  const alreadyVerified = memberHasVerifiedRole(interaction.member, config);
  const chunks = chunkPoints(points);
  const multiMessage = chunks.length > 1;

  let startIndex = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const isFirst = i === 0;
    const isLast = i === chunks.length - 1;

    const container = buildChunkContainer(interaction.guild, chunk, config, new Set(), alreadyVerified, {
      isFirst,
      isLast,
      startIndex,
      multiMessage,
    });

    let message;
    if (isFirst) {
      await interaction.reply({
        components: [container],
        flags: MessageFlags.Ephemeral | V2_FLAGS,
      });
      message = await interaction.fetchReply();
    } else {
      message = await interaction.followUp({
        components: [container],
        flags: MessageFlags.Ephemeral | V2_FLAGS,
      });
    }

    chunkMetaByMessage.set(message.id, {
      pointIds: chunk.map(p => String(p.id)),
      startIndex,
      isLast,
    });
    touchMessage(message.id);

    startIndex += chunk.length;
  }
}

// Kliknięcie "Rozwiń"/"Zwiń" PRZY KONKRETNYM punkcie - dopisuje (lub chowa) doprecyzowanie
// TEGO punktu w miejscu, edytując tę samą wiadomość (interaction.update()), bez ruszania
// pozostałych wiadomości (jeśli regulamin jest podzielony na kilka).
async function handlePrivateExpandClick(interaction) {
  const id = interaction.customId.slice(RULE_PRIVATE_EXPAND_PREFIX.length);
  const guildId = interaction.guild.id;
  const config = await db.getGuildConfig(guildId);
  const points = await db.getRulePoints(guildId);
  const expanded = getExpandedSet(interaction.message.id);

  if (expanded.has(id)) {
    expanded.delete(id);
  } else {
    expanded.add(id);
  }

  const alreadyVerified = memberHasVerifiedRole(interaction.member, config);
  const meta = chunkMetaByMessage.get(interaction.message.id);

  // Fallback (nie powinien wystąpić w normalnym użyciu): jeśli z jakiegoś powodu
  // nie mamy zapisanej "porcji" dla tej wiadomości, traktujemy ją jako całość.
  const chunk = meta ? points.filter(p => meta.pointIds.includes(String(p.id))) : points;
  const startIndex = meta?.startIndex ?? 0;
  const isLast = meta?.isLast ?? true;
  const isFirst = startIndex === 0;

  const container = buildChunkContainer(interaction.guild, chunk, config, expanded, alreadyVerified, {
    isFirst,
    isLast,
    startIndex,
    multiMessage: chunkMetaByMessage.size > 1,
  });

  await interaction.update({ components: [container], flags: V2_FLAGS });
}

// Kliknięcie przycisku akceptacji na DOLE OSTATNIEJ wiadomości - nadaje rolę (jeśli jeszcze
// nie ma) i przebudowuje TĘ wiadomość, zamieniając przycisk na potwierdzenie.
async function handleAcceptClick(interaction) {
  const guildId = interaction.guild.id;
  const config = await db.getGuildConfig(guildId);

  if (!config?.verify_role_id) {
    await interaction.reply({
      content: '⚠️ Administracja nie skonfigurowała jeszcze roli nadawanej po akceptacji (`/setup-regulamin ustaw`).',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const role = await interaction.guild.roles.fetch(config.verify_role_id).catch(() => null);
  if (!role) {
    await interaction.reply({
      content: '⚠️ Skonfigurowana rola weryfikacyjna już nie istnieje na serwerze — zgłoś to administracji.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const member = interaction.member;
  if (!member.roles.cache.has(role.id)) {
    try {
      await member.roles.add(role);
      if (
        config.starter_role_id &&
        config.starter_role_replace_on_verify &&
        member.roles.cache.has(config.starter_role_id)
      ) {
        await member.roles.remove(config.starter_role_id).catch(err =>
          console.error('Nie udało się zdjąć roli startowej po akceptacji regulaminu:', err)
        );
      }
    } catch (err) {
      console.error('Błąd podczas nadawania roli przy akceptacji regulaminu (przycisk):', err);
      await interaction.reply({
        content:
          '❌ Nie udało się nadać roli. Sprawdź, czy rola bota jest **wyżej** niż rola weryfikacyjna ' +
          '(Ustawienia serwera -> Role) i czy bot ma uprawnienie **Zarządzaj rolami**.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  const points = await db.getRulePoints(guildId);
  const expanded = getExpandedSet(interaction.message.id);
  const meta = chunkMetaByMessage.get(interaction.message.id);

  const chunk = meta ? points.filter(p => meta.pointIds.includes(String(p.id))) : points;
  const startIndex = meta?.startIndex ?? 0;
  const isLast = meta?.isLast ?? true;
  const isFirst = startIndex === 0;

  const container = buildChunkContainer(interaction.guild, chunk, config, expanded, true, {
    isFirst,
    isLast,
    startIndex,
    multiMessage: chunkMetaByMessage.size > 1,
  });

  await interaction.update({ components: [container], flags: V2_FLAGS });
}

module.exports = {
  RULE_PRIVATE_OPEN_ID,
  RULE_PRIVATE_EXPAND_PREFIX,
  RULE_ACCEPT_ID,
  V2_FLAGS,
  DEFAULT_RULES_TITLE,
  DEFAULT_RULES_TEXT,
  DEFAULT_BUTTON_LABEL,
  DEFAULT_INTRO_COMMENT,
  DEFAULT_ACCEPT_TITLE,
  DEFAULT_ACCEPT_TEXT,
  DEFAULT_ACCEPT_BUTTON_LABEL,
  DEFAULT_ACCEPT_COMMENT,
  buildIntroContainer,
  buildRegulaminContainer,
  handleOpenPrivateView,
  handlePrivateExpandClick,
  handleAcceptClick,
};
