const {
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
} = require('discord.js');
const { formatCoins } = require('./economy');

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

// Wszystkie wiadomości gry to Components V2 (jak /sklep i /ekwipunek): kontener z tekstami i sekcjami z przyciskami.
// W V2 nie ma pól content/embeds, więc wzmianka o graczu jest zwykłym tekstem (allowedMentions nic nie pinguje).
const V2 = MessageFlags.IsComponentsV2;
const small = () => new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small);
const text = (content) => new TextDisplayBuilder().setContent(content);
const payloadOf = (container) => ({ components: [container], flags: V2, allowedMentions: noPings });

// Krótka wiadomość tekstowa (błędy, brak wyboru): też w V2, bo w wiadomości V2 nie wolno wrócić do content/embeds
const messagePayload = (content, color = 0x95a5a6) =>
  payloadOf(new ContainerBuilder().setAccentColor(color).addTextDisplayComponents(text(content)));

// Jedna skrzynia: { coins, item (obiekt z katalogu albo null), score, label, color }
function describe(c) {
  const parts = [];
  if (c.coins > 0) parts.push(formatCoins(c.coins));
  if (c.item) parts.push(`${c.item.emoji} **${c.item.name}**`);
  if (parts.length === 0) parts.push('pusto');
  return `${c.label ? `${c.label}: ` : ''}${parts.join(' + ')}`;
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

  // ---------- Etap 1: wybór ----------
  const buildPick = () => {
    const luckText = luck > 0 ? ` • 🍀 szczęście +${luck}%` : '';
    const container = new ContainerBuilder().setAccentColor(0x7a5420).addTextDisplayComponents(
      text(`${user} stoi przed trzema skrzyniami!`),
      text(`## ${title}: wybierz jedną z trzech!`),
      text(
        '-# Bob stawia na ladzie **trzy skrzynie** i patrzy spod oka. W każdej jest inna zawartość.' +
        (modifier === 'latarka' ? '\n🔦 **Latarka:** jedna skrzynia odpadła, zobacz niżej, co w niej było.' : '') +
        (modifier === 'klucz' ? '\n🗝️ **Zapasowy klucz:** po wyborze otworzysz też lepszą z pozostałych.' : ''),
      ),
      small(),
    );

    chests.forEach((c, i) => {
      const gone = i === removed;
      const button = new ButtonBuilder()
        .setCustomId(`chest_${i}`)
        .setStyle(gone ? ButtonStyle.Secondary : ButtonStyle.Primary)
        .setLabel(gone ? 'Odpadła' : 'Otwórz')
        .setEmoji(gone ? '🔦' : '📦')
        .setDisabled(gone);
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(text(gone
            ? `### ~~Skrzynia ${i + 1}~~\n-# było w niej: ${describe(c)}`
            : `### 📦 Skrzynia ${i + 1}\n-# zamknięta na kłódkę`))
          .setButtonAccessory(button),
      );
    });

    container.addSeparatorComponents(small());
    container.addTextDisplayComponents(text(`-# wybiera: ${nameOf(user)} • masz ${Math.round(pickTimeMs / 1000)} s${luckText}`));
    return payloadOf(container);
  };

  const message = await send(buildPick());

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

    // ---------- Etap 2: otwieranie ----------
    const opening = new ContainerBuilder().setAccentColor(0xd4af37).addTextDisplayComponents(
      text(`${user} otwiera skrzynię **${selected + 1}**!`),
      text(`## ${title}`),
      text(`🔒 Skrzynia **${selected + 1}**: zamek trzeszczy, wieko drży, a spod niego przebija się światło... ✨`),
      text(`# ${[0, 1, 2].map((i) => (i === selected ? '✨' : '⬛')).join(' ')}`),
    );
    await click.update(payloadOf(opening))
      .catch((err) => console.error('Skrzynia: etap 2 nie powiódł się:', err.message));

    let result;
    try {
      result = await settle(selected, extra);
    } catch (err) {
      console.error('Skrzynia: błąd zapisu:', err);
      await edit(messagePayload('❌ Coś poszło nie tak przy zapisie. Nic nie zostało pobrane ani wypłacone, spróbuj za chwilę ponownie.', 0xe74c3c));
      return;
    }
    if (!result.ok) {
      await edit(messagePayload(result.message, 0xe74c3c));
      return;
    }

    await sleep(openDelayMs);

    // ---------- Etap 3: odsłonięcie ----------
    const chosen = chests[selected];
    const totalCoins = chosen.coins + (extra !== null ? chests[extra].coins : 0);
    const lines = chests.map((c, i) => {
      const mark = i === selected ? '▶️' : i === extra ? '🗝️' : i === removed ? '🔦' : '▫️';
      const name = i === selected ? `**Skrzynia ${i + 1}:**` : `Skrzynia ${i + 1}:`; // pogrubiamy tylko nazwę, bo przedmiot ma już własne pogrubienie
      return `${mark} ${name} ${describe(c)}${i === removed ? ' *(odpadła)*' : ''}`;
    });

    const gotItems = (result.granted ?? []);
    const skipped = [chosen.item, extra !== null ? chests[extra].item : null].filter((it) => it && !gotItems.includes(it.id));
    const bestOther = Math.max(...chests.filter((_, i) => i !== selected && i !== removed).map((c) => c.score));
    const verdict = extra !== null ? null : chosen.score >= bestOther ? '🏆 Wybrałeś/aś najlepszą ze skrzyń do wyboru!' : '😬 W innej skrzyni było więcej.';

    const gains = [];
    if (totalCoins > 0) gains.push(`Zyskujesz: ${formatCoins(totalCoins)}`);
    if (gotItems.length) {
      gains.push(`🎁 Do ekwipunku: ${gotItems.map((id) => { const it = chests.map((c) => c.item).find((x) => x?.id === id); return it ? `${it.emoji} **${it.name}**` : id; }).join(', ')}`);
    }
    if (skipped.length) gains.push(`ℹ️ ${skipped.map((x) => x.name).join(', ')}: już to masz (stały przedmiot, pominięty).`);
    // Saldo pokazujemy tylko wtedy, gdy się zmieniło (skrzynie ze sklepu nie dają monet)
    if (totalCoins > 0) gains.push(`Saldo: ${formatCoins(result.balance)}`);

    const reveal = new ContainerBuilder().setAccentColor(chosen.color ?? 0xd4af37).addTextDisplayComponents(
      text(`${user}`),
      text('## 🎁 Skrzynia otwarta!'),
      text(lines.join('\n')),
    );
    if (verdict) reveal.addTextDisplayComponents(text(verdict));
    reveal.addSeparatorComponents(small());
    if (gains.length) reveal.addTextDisplayComponents(text(gains.join('\n')));
    reveal.addTextDisplayComponents(text(`🥃 *Bob: ${quip ? quip(chosen) : 'Hm. Niezłe.'}*`));
    reveal.addSeparatorComponents(small());
    reveal.addTextDisplayComponents(text(`-# otworzył(a): ${nameOf(user)} • <t:${Math.floor(Date.now() / 1000)}:t>`));

    await edit(payloadOf(reveal));
  });

  collector.on('end', async (_collected, reason) => {
    if (reason === 'picked') return;
    await edit(messagePayload('⌛ Skrzynie zniknęły, bo nie wybrałeś/aś żadnej. Nic nie zostało zużyte, spróbuj ponownie.'));
  });
}

module.exports = { runChestGame, describe, TIER_QUIPS };
