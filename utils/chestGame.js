const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
} = require('discord.js');
const { formatCoins, CURRENCY } = require('./economy');

// Komentarz Boba do każdego poziomu (0 = Pospolita ... 6 = Void)
const TIER_QUIPS = [
  'Bywało gorzej. Ja kiedyś dostawałem same puste butelki.',
  'Przyzwoicie, starczy na porządną kolację.',
  'O, niezłe! Postaw koledze kolejkę, nie bądź skąpy.',
  'Legendarna! Takie rzeczy się pamięta latami.',
  'MITYCZNA?! Chowaj to szybko, zanim ja to zobaczę!',
  'Boska skrzynia... Przysięgam, że dzisiaj nie piłem.',
  'VOID. Czegoś takiego nie widziałem nigdy. Nikomu nie mów.',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const noPings = { parse: [] };
const nameOf = (user) => user.displayName ?? user.username;

// Jedna skrzynia: { coins, item (obiekt z katalogu albo null), score, label, color }
function describe(c) {
  const parts = [];
  if (c.coins > 0) parts.push(formatCoins(c.coins));
  if (c.item) parts.push(`${c.item.emoji} **${c.item.name}**`);
  if (parts.length === 0) parts.push('pusto');
  return `${c.label ? `${c.label}: ` : ''}${parts.join(' + ')}`;
}

function shortLabel(c) {
  const coins = c.coins > 0 ? c.coins.toLocaleString('pl-PL') : '';
  const item = c.item ? c.item.emoji : '';
  return `${coins}${coins && item ? ' ' : ''}${item}` || 'pusto';
}

function pickRow(chests, { disabledAll = false, selected = null, removed = null } = {}) {
  const row = new ActionRowBuilder();
  chests.forEach((c, i) => {
    const gone = i === removed;
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`chest_${i}`)
        .setLabel(gone ? `🔒 ${shortLabel(c)}` : `Skrzynia ${i + 1}`)
        .setEmoji(gone ? '🔦' : '📦')
        .setStyle(selected === i ? ButtonStyle.Success : gone ? ButtonStyle.Secondary : ButtonStyle.Primary)
        .setDisabled(disabledAll || gone),
    );
  });
  return row;
}

function revealRow(chests, selected, extra) {
  const row = new ActionRowBuilder();
  chests.forEach((c, i) => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`chest_${i}`)
        .setLabel(shortLabel(c))
        .setStyle(i === selected ? ButtonStyle.Success : i === extra ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(true),
    );
  });
  return row;
}

/**
 * Interaktywna gra: trzy skrzynie, wybierasz jedną przyciskiem.
 *  - send(payload)         wysyła publiczną wiadomość i zwraca obiekt wiadomości
 *  - edit(payload)         (opcjonalnie) własny sposób edycji tej wiadomości; domyślnie message.edit
 *  - user                  osoba, która gra (tylko ona może klikać)
 *  - chests                tablica trzech skrzyń (patrz wyżej)
 *  - modifier              null | 'latarka' (najgorsza odpada) | 'klucz' (dodatkowo otwierasz lepszą z reszty)
 *  - settle(sel, extra)    zapis w bazie; zwraca { ok: true, balance, granted: [id...] } albo { ok: false, message }
 *  - quip(chest)           komentarz Boba
 *  - title, luck, pickTimeMs, openDelayMs
 */
async function runChestGame(opts) {
  const {
    send, edit: editOverride, user, chests, modifier = null, settle, quip,
    title = '🎁 Skrzynia', luck = 0,
    pickTimeMs = 60_000, openDelayMs = 2000,
  } = opts;

  // Latarka: odpada skrzynia o najniższym wyniku (przy remisie pierwsza)
  let removed = null;
  if (modifier === 'latarka') {
    removed = chests.reduce((worst, c, i) => (c.score < chests[worst].score ? i : worst), 0);
  }

  const luckText = luck > 0 ? ` • 🍀 szczęście +${luck}%` : '';
  const pickEmbed = new EmbedBuilder()
    .setColor(0x7a5420)
    .setTitle(`${title}: wybierz jedną z trzech!`)
    .setDescription(
      '📦 Bob stawia na ladzie **trzy skrzynie** i patrzy spod oka.\nW każdej jest inna zawartość. Którą otwierasz?\n' +
      (modifier === 'latarka' ? `\n🔦 **Latarka:** skrzynia ${removed + 1} odpadła. W środku było: ${describe(chests[removed])}\n` : '') +
      (modifier === 'klucz' ? '\n🗝️ **Zapasowy klucz:** po wyborze otworzysz też lepszą z pozostałych.\n' : '') +
      '\n# ⬛ ⬛ ⬛',
    )
    .setFooter({ text: `Etap 1/3 • wybiera: ${nameOf(user)} • masz ${Math.round(pickTimeMs / 1000)} s${luckText}` });

  const message = await send({
    content: `${user} stoi przed trzema skrzyniami!`,
    embeds: [pickEmbed],
    components: [pickRow(chests, { removed })],
    allowedMentions: noPings,
  });

  const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: pickTimeMs });
  let picked = false; // ustawiane synchronicznie: szybkie podwójne kliknięcie nie otworzy dwóch skrzyń

  const edit = async (payload) => {
    try {
      await (editOverride ? editOverride(payload) : message.edit(payload));
    } catch (err) {
      console.error('Skrzynia: nie udało się edytować wiadomości:', err.message);
      await message.channel?.send(payload).catch(() => null);
    }
  };

  collector.on('collect', async (click) => {
    if (click.user.id !== user.id) {
      await click.reply({ content: 'To nie Twoja skrzynia! Wpisz własne polecenie. 😉', flags: MessageFlags.Ephemeral }).catch(() => null);
      return;
    }
    if (picked) { await click.deferUpdate().catch(() => null); return; }

    const selected = Number(click.customId.replace('chest_', ''));
    if (!Number.isInteger(selected) || selected === removed || !chests[selected]) {
      await click.deferUpdate().catch(() => null);
      return;
    }
    picked = true;
    collector.stop('picked');

    // Klucz: dodatkowo najlepsza z pozostałych dwóch
    let extra = null;
    if (modifier === 'klucz') {
      const rest = chests.map((c, i) => ({ c, i })).filter(({ i }) => i !== selected);
      extra = rest.reduce((best, cur) => (cur.c.score > best.c.score ? cur : best)).i;
    }

    // Etap 2/3
    await click.update({
      content: `${user} otwiera skrzynię **${selected + 1}**!`,
      embeds: [
        new EmbedBuilder()
          .setColor(0xd4af37)
          .setTitle(title)
          .setDescription(`🔒 Skrzynia **${selected + 1}**: zamek trzeszczy, wieko drży, a spod niego przebija się światło... ✨\n\n# ${[0, 1, 2].map((i) => (i === selected ? '✨' : '⬛')).join(' ')}`)
          .setFooter({ text: `Etap 2/3 • otwiera: ${nameOf(user)}` }),
      ],
      components: [pickRow(chests, { disabledAll: true, selected, removed })],
      allowedMentions: noPings,
    }).catch((err) => console.error('Skrzynia: etap 2 nie powiódł się:', err.message));

    let result;
    try {
      result = await settle(selected, extra);
    } catch (err) {
      console.error('Skrzynia: błąd zapisu:', err);
      await edit({ content: '❌ Coś poszło nie tak przy zapisie. Nic nie zostało pobrane ani wypłacone, spróbuj za chwilę ponownie.', embeds: [], components: [], allowedMentions: noPings });
      return;
    }
    if (!result.ok) {
      await edit({ content: result.message, embeds: [], components: [], allowedMentions: noPings });
      return;
    }

    await sleep(openDelayMs);

    // Etap 3/3: odsłonięcie
    const chosen = chests[selected];
    const totalCoins = chosen.coins + (extra !== null ? chests[extra].coins : 0);
    const lines = chests.map((c, i) => {
      const mark = i === selected ? '▶️' : i === extra ? '🗝️' : i === removed ? '🔦' : '▫️';
      return `${mark} Skrzynia ${i + 1}: ${describe(c)}${i === removed ? ' *(odpadła)*' : ''}`;
    });

    const gotItems = (result.granted ?? []);
    const skipped = [chosen.item, extra !== null ? chests[extra].item : null].filter((it) => it && !gotItems.includes(it.id));
    const bestOther = Math.max(...chests.filter((_, i) => i !== selected && i !== removed).map((c) => c.score));
    const verdict = extra !== null ? '' : chosen.score >= bestOther ? '\n🏆 Wybrałeś/aś najlepszą ze skrzyń do wyboru!' : '\n😬 W innej skrzyni było więcej.';

    const reveal = new EmbedBuilder()
      .setColor(chosen.color ?? 0xd4af37)
      .setTitle('🎁 Skrzynia otwarta!')
      .setDescription(
        `**KLIK!**\n${lines.join('\n')}${verdict}\n\n` +
        `${CURRENCY.emoji} Zyskujesz: ${totalCoins > 0 ? formatCoins(totalCoins) : 'same przedmioty'}\n` +
        (gotItems.length ? `🎁 Do ekwipunku: ${gotItems.map((id) => { const it = chests.map((c) => c.item).find((x) => x?.id === id); return it ? `${it.emoji} **${it.name}**` : id; }).join(', ')}\n` : '') +
        (skipped.length ? `ℹ️ ${skipped.map((s) => s.name).join(', ')}: już to masz (stały przedmiot, pominięty).\n` : '') +
        `Saldo: ${formatCoins(result.balance)}\n\n` +
        `🥃 *Bob: ${quip ? quip(chosen) : 'Hm. Niezłe.'}*`,
      )
      .setFooter({ text: `Etap 3/3 • otworzył(a): ${nameOf(user)}` })
      .setTimestamp();

    await edit({
      content: `${user}`,
      embeds: [reveal],
      components: [revealRow(chests, selected, extra)],
      allowedMentions: noPings,
    });
  });

  collector.on('end', async (_collected, reason) => {
    if (reason === 'picked') return;
    await edit({
      content: '⌛ Skrzynie zniknęły, bo nie wybrałeś/aś żadnej. Nic nie zostało zużyte, spróbuj ponownie.',
      embeds: [],
      components: [],
      allowedMentions: noPings,
    });
  });
}

module.exports = { runChestGame, describe, TIER_QUIPS };
