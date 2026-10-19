const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const db = require('../db');

// Rozpoznaje czy podane emoji to custom (<:nazwa:id> lub <a:nazwa:id>) czy zwykły unicode znak.
function parseEmojiInput(raw) {
  if (!raw) return { id: null, name: '❓', raw: '❓', key: '❓' };
  const trimmed = raw.trim();
  const customMatch = trimmed.match(/^<a?:(\w+):(\d+)>$/);
  if (customMatch) {
    const [, name, id] = customMatch;
    return { id, name, raw: trimmed, key: id };
  }
  return { id: null, name: trimmed, raw: trimmed, key: trimmed };
}

// Format akceptowany przez ButtonBuilder#setEmoji
function toButtonEmoji(parsed) {
  return parsed.id ? { id: parsed.id, name: parsed.name } : parsed.name;
}

function buildPanelEmbed(panel, items, guild) {
  const embed = new EmbedBuilder()
    .setTitle(panel.title || '🎭 Wybierz swoje role')
    .setColor(0x5865f2);

  if (panel.description) {
    embed.setDescription(panel.description);
  }

  const safeItems = Array.isArray(items) ? items : [];

  if (safeItems.length === 0) {
    embed.addFields({ name: 'Brak ról', value: '_Panel jest jeszcze pusty - użyj `/rola-panel dodaj`, aby dodać role._' });
  } else if (panel.mode === 'emoji') {
    const lines = safeItems.map(item => `${item.emoji_raw ?? '❔'} — <@&${item.role_id}>`);
    embed.addFields({ name: 'Zareaguj, aby dostać rolę', value: lines.join('\n') });
  } else {
    const lines = safeItems.map(item => `${item.emoji_raw ?? ''} **${item.label ?? ''}** — <@&${item.role_id}>`);
    embed.addFields({ name: 'Kliknij przycisk, aby dostać rolę', value: lines.join('\n') });
  }

  embed.setFooter({ 
    text: panel.mode === 'emoji' ? 'Kliknij reakcję ponownie, żeby zdjąć rolę' : 'Kliknij przycisk ponownie, żeby zdjąć rolę' 
  });

  return embed;
}

function buildPanelComponents(panel, items) {
  const safeItems = Array.isArray(items) ? items : [];
  if (panel.mode !== 'button' || safeItems.length === 0) return [];

  const rows = [];
  for (let i = 0; i < safeItems.length; i += 5) {
    const chunk = safeItems.slice(i, i + 5);
    const row = new ActionRowBuilder().addComponents(
      chunk.map(item => {
        const btn = new ButtonBuilder()
          .setCustomId(item.custom_id || `role_btn_${panel.id}_${item.role_id}`)
          .setLabel(item.label ?? 'Rola')
          .setStyle(ButtonStyle.Secondary);
        if (item.emoji_raw) {
          const parsed = parseEmojiInput(item.emoji_raw);
          btn.setEmoji(toButtonEmoji(parsed));
        }
        return btn;
      }),
    );
    rows.push(row);
  }
  return rows;
}

// Odświeża wiadomość panelu (embed + ewentualne przyciski) po każdej zmianie.
async function refreshPanelMessage(client, panelId) {
  const panel = await db.getRolePanel(panelId);
  if (!panel || !panel.message_id) return false;

  const guild = await client.guilds.fetch(panel.guild_id).catch(() => null);
  if (!guild) return false;

  const channel = await guild.channels.fetch(panel.channel_id).catch(() => null);
  if (!channel || !channel.isTextBased()) return false;

  const message = await channel.messages.fetch(panel.message_id).catch(() => null);
  if (!message) return false;

  let rawItems = await db.getRolePanelItems(panelId);
  let items = Array.isArray(rawItems) ? rawItems : (rawItems?.data || []);

  const embed = buildPanelEmbed(panel, items, guild);
  const components = buildPanelComponents(panel, items);

  await message.edit({ embeds: [embed], components }).catch(() => null);

  if (panel.mode === 'emoji') {
    for (const item of items) {
      const already = message.reactions.cache.some(r =>
        item.emoji_key && (r.emoji.id === item.emoji_key || r.emoji.name === item.emoji_key),
      );
      if (!already && item.emoji_raw) {
        await message.react(item.emoji_raw).catch(() => null);
      }
    }

    // Usuń stare reakcje po usunięciu roli
    for (const reaction of message.reactions.cache.values()) {
      const key = reaction.emoji.id ?? reaction.emoji.name;
      const stillConfigured = items.some(item => item.emoji_key === key);
      if (!stillConfigured) {
        await reaction.remove().catch(() => null);
      }
    }
  }

  return true;
}

// Obsługa kliknięcia przycisku roli - przełącza (toggle) rolę użytkownikowi
async function handleRoleButtonClick(interaction) {
  const item = await db.getRolePanelItemByCustomId(interaction.customId);
  if (!item) return false;

  const panel = await db.getRolePanel(item.panel_id);
  const member = interaction.member;
  const role = await interaction.guild.roles.fetch(item.role_id).catch(() => null);

  if (!role) {
    await interaction.reply({ content: '⚠️ Ta rola już nie istnieje w ustawieniach serwera.', flags: MessageFlags.Ephemeral });
    return true;
  }

  try {
    if (member.roles.cache.has(role.id)) {
      await member.roles.remove(role);
      await interaction.reply({ content: `➖ Zdjęto rolę **${role.name}**.`, flags: MessageFlags.Ephemeral });
    } else {
      await member.roles.add(role);
      await interaction.reply({ content: `➕ Nadano rolę **${role.name}**!`, flags: MessageFlags.Ephemeral });
    }
  } catch (err) {
    console.error('Błąd podczas nadawania/zdejmowania roli (przycisk):', err);
    await interaction.reply({
      content: '❌ Nie udało się zmienić roli. Upewnij się, że rola bota znajduje się **WYŻEJ** w hierarchii serwera niż nadawana rola.',
      flags: MessageFlags.Ephemeral,
    });
  }
  return true;
}

// Obsługa reakcji (dodanie/usunięcie) - przełącza rolę użytkownikowi
async function handleReactionToggle(reaction, user, added) {
  if (user.bot) return;

  if (reaction.partial) {
    reaction = await reaction.fetch().catch(() => null);
    if (!reaction) return;
  }
  if (reaction.message.partial) {
    await reaction.message.fetch().catch(() => null);
  }

  const panel = await db.getRolePanelByMessageId(reaction.message.id);
  if (!panel || panel.mode !== 'emoji') return;

  const emojiKey = reaction.emoji.id ?? reaction.emoji.name;
  const item = await db.getRolePanelItemByEmojiKey(panel.id, emojiKey);
  if (!item) return;

  const guild = reaction.message.guild;
  if (!guild) return;

  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) return;

  const role = await guild.roles.fetch(item.role_id).catch(() => null);
  if (!role) return;

  try {
    if (added) {
      await member.roles.add(role);
    } else {
      await member.roles.remove(role);
    }
  } catch (err) {
    console.error('Błąd podczas nadawania/zdejmowania roli (reakcja):', err);
  }
}

module.exports = {
  parseEmojiInput,
  toButtonEmoji,
  buildPanelEmbed,
  buildPanelComponents,
  refreshPanelMessage,
  handleRoleButtonClick,
  handleReactionToggle,
};
