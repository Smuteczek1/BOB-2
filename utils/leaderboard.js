const { EmbedBuilder } = require('discord.js');
const db = require('../db');

function formatDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || h > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

async function buildLeaderboardEmbed(guild) {
  // Pobieranie danych z bazy z użyciem await
  const topAllTime = await db.getTopAllTime(guild.id, 5);
  const topMonth = await db.getTopThisMonth(guild.id, 5);

  const monthName = new Date().toLocaleString('pl-PL', { month: 'long', year: 'numeric' });

  const formatList = (rows) => {
    if (!rows || rows.length === 0) return '_Brak danych jeszcze_';
    return rows
      .map((row, i) => {
        const medal = ['🥇', '🥈', '🥉', '🏅', '🏅'][i] ?? '▫️';
        
        // --- BEZPIECZNE PARSOWANIE DATY ---
        let rawDate = row.started_at;
        if (typeof rawDate === 'string' && !isNaN(rawDate)) {
          rawDate = Number(rawDate); // konwersja ze stringa numerycznego na liczbę
        }
        const parsedDate = new Date(rawDate);
        const when = !isNaN(parsedDate.getTime()) 
          ? parsedDate.toLocaleDateString('pl-PL') 
          : 'brak daty';
        // -----------------------------------

        return `${medal} **${formatDuration(row.duration_seconds)}** — <@${row.creator_id ?? 'nieznany'}> (${when})`;
      })
      .join('\n');
  };

  return new EmbedBuilder()
    .setTitle('🏆 Rekordy kanałów głosowych')
    .setColor(0x5865f2)
    .addFields(
      { name: '🌍 Top 5 — cały czas', value: formatList(topAllTime) },
      { name: `📅 Top 5 — ${monthName}`, value: formatList(topMonth) },
    )
    .setFooter({ text: 'Aktualizowane automatycznie po zakończeniu każdej rozmowy' })
    .setTimestamp();
}

async function updateLeaderboard(client, guildId) {
  // Dodane await do pobierania konfiguracji z bazy
  const config = await db.getGuildConfig(guildId);
  if (!config || !config.stats_channel_id) return;

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  const channel = await guild.channels.fetch(config.stats_channel_id).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  // Funkcja budująca embed też stała się asynchroniczna przez zapytania do bazy
  const embed = await buildLeaderboardEmbed(guild);

  // Próbujemy edytować istniejącą wiadomość, żeby nie zaśmiecać kanału
  if (config.leaderboard_message_id) {
    const existingMsg = await channel.messages.fetch(config.leaderboard_message_id).catch(() => null);
    if (existingMsg) {
      await existingMsg.edit({ embeds: [embed] }).catch(() => null);
      return;
    }
  }

  const sentMsg = await channel.send({ embeds: [embed] }).catch(() => null);
  if (sentMsg) {
    // Dodane await przy zapisie ID wiadomości
    await db.setLeaderboardMessageId(guildId, sentMsg.id);
  }
}

module.exports = { formatDuration, buildLeaderboardEmbed, updateLeaderboard };
