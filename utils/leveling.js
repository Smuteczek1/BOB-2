const { EmbedBuilder } = require('discord.js');
const db = require('../db');
const { syncLevelRole } = require('./levelRoles');

// --- Konfiguracja czasów ---
const CHAT_COOLDOWN_MIN = Number(process.env.XP_CHAT_COOLDOWN_MIN ?? 1);
const CHAT_COOLDOWN_MAX = Number(process.env.XP_CHAT_COOLDOWN_MAX ?? 3);
const VOICE_COOLDOWN_MIN = Number(process.env.XP_VOICE_COOLDOWN_MIN ?? 5);
const VOICE_COOLDOWN_MAX = Number(process.env.XP_VOICE_COOLDOWN_MAX ?? 10);

// Szybkie pomoce losowania
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// System wymagania XP: Wzrost o +5% co poziom
function xpNeededForLevel(level) {
  const baseValue = 100;
  return Math.floor(baseValue * Math.pow(1.05, level - 1));
}

function levelForXp(totalXp) {
  let level = 0;
  let remaining = totalXp;
  while (remaining >= xpNeededForLevel(level + 1)) {
    remaining -= xpNeededForLevel(level + 1);
    level += 1;
  }
  return level;
}

const EXPLICIT_MILESTONES = [5, 10, 15, 20, 30, 40, 50, 75, 100, 150, 200, 300, 400, 500, 600, 700, 800, 900];
function isMilestone(level) {
  if (EXPLICIT_MILESTONES.includes(level)) return true;
  return level > 900 && level % 100 === 0;
}

async function announceIfMilestone(client, guildId, userId, oldLevel, newLevel) {
  if (newLevel <= oldLevel) return;

  const milestonesHit = [];
  for (let lvl = oldLevel + 1; lvl <= newLevel; lvl++) {
    if (isMilestone(lvl)) milestonesHit.push(lvl);
  }
  if (milestonesHit.length === 0) return;

  const config = await db.getGuildConfig(guildId);
  if (!config || !config.levels_channel_id) return;

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  const channel = await guild.channels.fetch(config.levels_channel_id).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  const topMilestone = milestonesHit[milestonesHit.length - 1];

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setDescription(`🎉 <@${userId}> osiągnął/osiągnęła **poziom ${topMilestone}**!`)
    .setTimestamp();

  await channel.send({ content: `<@${userId}>`, embeds: [embed] }).catch(() => null);
}

// XP za pisanie na czacie (10 - 20 XP, cooldown 1 - 3 min)
async function grantTextXp(client, message) {
  if (message.author.bot || !message.guild) return;

  const cooldownMs = randomInt(CHAT_COOLDOWN_MIN, CHAT_COOLDOWN_MAX) * 60 * 1000;
  const canGet = await db.canGetTextXp(message.guild.id, message.author.id, cooldownMs);
  if (!canGet) return;

  const amount = randomInt(10, 20);
  const { oldLevel, newLevel } = await db.addXp(message.guild.id, message.author.id, amount, 'text', levelForXp);

  if (newLevel > oldLevel) {
    await syncLevelRole(client, message.guild.id, message.author.id, newLevel);
  }
  await announceIfMilestone(client, message.guild.id, message.author.id, oldLevel, newLevel);
}

// XP za kanały głosowe z przelicznikiem osób
async function tickVoiceXp(client) {
  for (const guild of client.guilds.cache.values()) {
    for (const channel of guild.channels.cache.values()) {
      if (!channel.isVoiceBased?.() || channel.id === guild.afkChannelId) continue;

      const humanMembers = channel.members.filter(m => !m.user.bot);
      const count = humanMembers.size;
      if (count === 0) continue;

      // Wyliczanie procentowego mnożnika XP
      let multiplier = 1.0;
      if (count === 1) multiplier = 0.25;
      else if (count === 2) multiplier = 0.50;
      else if (count >= 3) {
        multiplier = 1.0 + (count - 3) * 0.25;
        if (multiplier > 2.50) multiplier = 2.50; // max 250%
      }

      for (const member of humanMembers.values()) {
        const baseAmount = randomInt(5, 10);
        const finalAmount = Math.max(1, Math.floor(baseAmount * multiplier));

        const { oldLevel, newLevel } = await db.addXp(guild.id, member.id, finalAmount, 'voice', levelForXp);

        if (newLevel > oldLevel) {
          await syncLevelRole(client, guild.id, member.id, newLevel);
        }
        await announceIfMilestone(client, guild.id, member.id, oldLevel, newLevel);
      }
    }
  }
}

module.exports = {
  isMilestone,
  xpNeededForLevel,
  levelForXp,
  grantTextXp,
  tickVoiceXp,
  randomInt,
};
