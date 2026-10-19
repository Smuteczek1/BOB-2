const { ChannelType } = require('discord.js');
const db = require('../db');
const { updateLeaderboard } = require('../utils/leaderboard');

module.exports = {
  name: 'voiceStateUpdate',
  async execute(oldState, newState) {
    const guild = newState.guild ?? oldState.guild;
    if (!guild) return;

    // Pobieramy konfigurację serwera asynchronicznie z bazy
    const config = await db.getGuildConfig(guild.id);
    if (!config || !config.hub_channel_id) return;

    // --- 1) DOŁĄCZENIE do kanału "Utwórz kanał" (Hub) ---
    if (newState.channelId && newState.channelId === config.hub_channel_id) {
      await handleJoinHub(newState, guild);
    }

    // --- 2) OPUŚZCZENIE kanału -> sprawdzamy czy to tymczasowy kanał i czy jest pusty ---
    if (oldState.channelId && oldState.channelId !== newState.channelId) {
      // Zabezpieczenie: NIGDY nie usuwamy głównego kanału "Utwórz kanał" (Hub)
      if (oldState.channelId !== config.hub_channel_id) {
        await handlePossibleEmptyTempChannel(oldState.channelId, guild);
      }
    }
  },
};

async function handleJoinHub(newState, guild) {
  const member = newState.member;
  const hubChannel = newState.channel;
  if (!hubChannel || !member) return;

  try {
    const newChannel = await guild.channels.create({
      name: `🔊 Kanał ${member.displayName}`,
      type: ChannelType.GuildVoice,
      parent: hubChannel.parent ?? null,
      bitrate: hubChannel.bitrate,
      userLimit: hubChannel.userLimit,
      reason: `Tymczasowy kanał dla ${member.user.tag}`,
    });

    // Zapisujemy nowy kanał w bazie z użyciem await
    await db.addTempChannel(newChannel.id, guild.id, member.id);

    // Przenosimy użytkownika na nowo utworzony kanał
    await member.voice.setChannel(newChannel).catch(() => null);
  } catch (err) {
    console.error('Nie udało się utworzyć tymczasowego kanału:', err);
  }
}

async function handlePossibleEmptyTempChannel(channelId, guild) {
  // Odczytujemy dane tymczasowego kanału z bazy z użyciem await
  const tempInfo = await db.getTempChannel(channelId);
  if (!tempInfo) return; // Jeśli to nie jest kanał z bazy, nic nie robimy

  const channel = await guild.channels.fetch(channelId).catch(() => null);

  // Jeśli kanał już nie istnieje (został usunięty ręcznie), sprzątamy po nim wpis
  if (!channel) {
    await db.removeTempChannel(channelId);
    return;
  }

  // Jeśli kanał jest pusty, usuwamy go i zapisujemy sesję
  if (channel.members.size === 0) {
    const startedAt = tempInfo.started_at;
    const endedAt = Date.now();

    await db.addSession(guild.id, channelId, tempInfo.creator_id, startedAt, endedAt);
    await db.removeTempChannel(channelId);

    await channel.delete('Tymczasowy kanał opustoszał').catch(() => null);
    await updateLeaderboard(guild.client, guild.id);
  }
}
