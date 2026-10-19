const { EmbedBuilder } = require('discord.js');
const db = require('../db');

const DEFAULT_WELCOME_MESSAGE =
  '🎉 Witaj {user} na serwerze **{server}**! Jesteś naszym **#{membercount}** członkiem, miło Cię widzieć!';

const DEFAULT_GOODBYE_MESSAGE =
  '👋 **{username}** opuścił(a) serwer **{server}**. Zostało nas **{membercount}**.';

// Podmienia dostępne placeholdery w treści wiadomości na dane konkretnego użytkownika/serwera.
// Dostępne zmienne: {user} {username} {tag} {server} {membercount}
function applyPlaceholders(template, member) {
  const username = member.user?.username ?? member.displayName ?? 'Nieznany użytkownik';
  const tag = member.user?.tag ?? username;

  return template
    .replaceAll('{user}', `<@${member.id}>`)
    .replaceAll('{username}', username)
    .replaceAll('{tag}', tag)
    .replaceAll('{server}', member.guild.name)
    .replaceAll('{membercount}', String(member.guild.memberCount));
}

function buildWelcomeEmbed(member, customMessage) {
  const text = applyPlaceholders(customMessage || DEFAULT_WELCOME_MESSAGE, member);

  return new EmbedBuilder()
    .setColor(0x57f287)
    .setAuthor({ name: member.guild.name, iconURL: member.guild.iconURL() ?? undefined })
    .setTitle('Nowy członek na serwerze! 🎉')
    .setDescription(text)
    .setThumbnail(member.user?.displayAvatarURL({ size: 256 }) ?? null)
    .setFooter({ text: `ID: ${member.id}` })
    .setTimestamp();
}

function buildGoodbyeEmbed(member, customMessage) {
  const text = applyPlaceholders(customMessage || DEFAULT_GOODBYE_MESSAGE, member);

  return new EmbedBuilder()
    .setColor(0xed4245)
    .setAuthor({ name: member.guild.name, iconURL: member.guild.iconURL() ?? undefined })
    .setTitle('Ktoś opuścił serwer 👋')
    .setDescription(text)
    .setThumbnail(member.user?.displayAvatarURL({ size: 256 }) ?? null)
    .setFooter({ text: `ID: ${member.id}` })
    .setTimestamp();
}

async function sendWelcomeMessage(member) {
  try {
    const config = await db.getGuildConfig(member.guild.id);
    if (!config || !config.welcome_channel_id) return;

    const channel = await member.guild.channels.fetch(config.welcome_channel_id).catch(() => null);
    if (!channel || !channel.isTextBased()) return;

    const embed = buildWelcomeEmbed(member, config.welcome_message);
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('Błąd podczas wysyłania wiadomości powitalnej:', err);
  }
}

async function sendGoodbyeMessage(member) {
  try {
    const config = await db.getGuildConfig(member.guild.id);
    if (!config || !config.goodbye_channel_id) return;

    const channel = await member.guild.channels.fetch(config.goodbye_channel_id).catch(() => null);
    if (!channel || !channel.isTextBased()) return;

    const embed = buildGoodbyeEmbed(member, config.goodbye_message);
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('Błąd podczas wysyłania wiadomości pożegnalnej:', err);
  }
}

module.exports = {
  DEFAULT_WELCOME_MESSAGE,
  DEFAULT_GOODBYE_MESSAGE,
  applyPlaceholders,
  buildWelcomeEmbed,
  buildGoodbyeEmbed,
  sendWelcomeMessage,
  sendGoodbyeMessage,
};
