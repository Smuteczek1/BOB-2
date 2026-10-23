const { EmbedBuilder } = require('discord.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const noPings = { parse: [] };
const nameOf = (user) => user.displayName ?? user.username;

/**
 * Proste otwieranie BEZ wyboru: najpierw "Otwieranie: <nazwa>", po chwili pokazanie, co było w środku.
 * Używane do skrzyń ze sklepu i do przedmiotów "pieniężnych" (Teczka ... Czarna Skrzynka).
 * (Dzienna nagroda /nagroda nadal korzysta z gry "trzy skrzynie" z utils/chestGame.js.)
 *
 *  - send(payload)   wysyła publiczną wiadomość i zwraca obiekt wiadomości; gdy się nie uda, funkcja RZUCA błąd
 *                    i NIC nie zostaje zużyte (zapis w bazie następuje dopiero po udanym wysłaniu)
 *  - user            osoba, która otwiera
 *  - emoji, name     co jest otwierane (np. '🟤', 'Skrzynia Brązowa')
 *  - settle()        zapis w bazie. Zwraca { ok: true, title, color, lines: [...], quip } albo { ok: false, message }
 *  - openDelayMs     jak długo trwa "otwieranie" przed pokazaniem zawartości
 * Zwraca { ok: true } albo { ok: false, message }.
 */
async function runOpening({ send, user, emoji, name, settle, openDelayMs = 2000 }) {
  const opening = new EmbedBuilder()
    .setColor(0xd4af37)
    .setTitle(`${emoji} Otwieranie: ${name}`)
    .setDescription('🔒 Zamek trzeszczy, wieko drży, a spod niego przebija się światło... ✨\n\n# ✨')
    .setFooter({ text: `Etap 1/2 • otwiera: ${nameOf(user)}` });

  const message = await send({
    content: `${user} otwiera: ${emoji} **${name}**!`,
    embeds: [opening],
    allowedMentions: noPings,
  });

  const edit = async (payload) => {
    try {
      await message.edit(payload);
    } catch (err) {
      console.error('Otwieranie: nie udało się edytować wiadomości:', err.message);
      await message.channel?.send(payload).catch(() => null);
    }
  };

  let result;
  try {
    result = await settle();
  } catch (err) {
    console.error('Otwieranie: błąd zapisu:', err);
    const msg = '❌ Coś poszło nie tak przy zapisie. Nic nie zostało zużyte ani wypłacone, spróbuj za chwilę ponownie.';
    await edit({ content: msg, embeds: [], allowedMentions: noPings });
    return { ok: false, message: 'Coś poszło nie tak przy zapisie. Nic nie zostało zużyte.' };
  }
  if (!result.ok) {
    await edit({ content: result.message, embeds: [], allowedMentions: noPings });
    return { ok: false, message: result.message.replace(/^❌\s*/, '') };
  }

  await sleep(openDelayMs);

  const reveal = new EmbedBuilder()
    .setColor(result.color ?? 0xd4af37)
    .setTitle(result.title)
    .setDescription(
      `**KLIK!**\n${result.lines.join('\n')}` +
      (result.quip ? `\n\n🥃 *Bob: ${result.quip}*` : ''),
    )
    .setFooter({ text: `Etap 2/2 • otworzył(a): ${nameOf(user)}` })
    .setTimestamp();

  await edit({ content: `${user}`, embeds: [reveal], allowedMentions: noPings });
  return { ok: true };
}

module.exports = { runOpening };
