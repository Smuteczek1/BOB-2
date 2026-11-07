const {
  SlashCommandBuilder, ContainerBuilder, SectionBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags,
} = require('discord.js');
const inv = require('../utils/inventory');
const items = require('../utils/items');
const { useItem } = require('../utils/itemUse');
const { TIER_QUIPS } = require('../utils/chestGame');
const { runOpening } = require('../utils/chestOpen');
const { DAILY_TIERS, formatCoins } = require('../utils/economy');

const PICK_TIME_MS = Number(process.env.CHEST_PICK_TIME_MS ?? 60_000);
const OPEN_DELAY_MS = Number(process.env.CHEST_FRAME_DELAY_MS ?? 2000);

// Ekwipunek jest zbudowany z Components V2 (jak /sklep). Discord pozwala na max 40 komponentów w wiadomości,
// a jeden wiersz z przyciskiem to 3 (sekcja + tekst + przycisk), więc lista dzieli się na strony.
const V2 = MessageFlags.IsComponentsV2;
const USE_PREFIX = 'inv_use:';   // inv_use:<id_przedmiotu>
const OPEN_PREFIX = 'inv_open:'; // inv_open:<id_skrzyni>
const PREV_ID = 'inv_prev';
const NEXT_ID = 'inv_next';
const PAGE_ID = 'inv_page';
const ROWS_PER_PAGE = 7;

const KIND_LABEL = { consumable: 'jednorazowy', permanent: 'stały', collectible: 'kolekcjonerski' };

// Przedmioty "pieniężne" (Teczka ... Czarna Skrzynka: nic / suma / mandat) otwierają się jak skrzynie
const isMoneyItem = (def) => def?.use?.type === 'money';
const GAIN_COLOR = 0x2ecc71; // kolor wyniku "wygrana" zwracany przez useItem

const fmtPct = (x) => String(Math.round(x * 10) / 10).replace('.', ',');
const nameOf = (user) => user.displayName ?? user.username;
const small = () => new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small);

// Lista pozycji z przyciskami: najpierw skrzynie (w kolejności z katalogu), potem przedmioty od najwyższego poziomu.
// Kolekcjonerskie nie mają przycisku, są pokazane osobno w tekście.
function collectEntries(inventory) {
  const chestOrder = Object.keys(items.CHESTS);
  const chests = inventory
    .filter((i) => items.isChest(i.itemId))
    .sort((a, b) => chestOrder.indexOf(a.itemId) - chestOrder.indexOf(b.itemId))
    .map((r) => ({ type: 'chest', def: items.CHESTS[r.itemId], qty: r.quantity }));
  const owned = inventory
    .filter((i) => !items.isChest(i.itemId) && items.ITEMS[i.itemId])
    .sort((a, b) => items.ITEMS[b.itemId].tier - items.ITEMS[a.itemId].tier);
  const usable = owned
    .filter((r) => items.ITEMS[r.itemId].kind !== 'collectible' && !items.ITEMS[r.itemId].luckFamily)
    .map((r) => ({ type: 'item', def: items.ITEMS[r.itemId], qty: r.quantity }));
  const collection = owned
    .filter((r) => items.ITEMS[r.itemId].kind === 'collectible')
    .map((r) => items.ITEMS[r.itemId]);
  return { entries: [...chests, ...usable], collection };
}

function entryText(e) {
  if (e.type === 'chest') {
    return `${e.def.emoji} **${e.def.name}** ×${e.qty}\n-# otwiera się publicznie na kanale`;
  }
  const d = e.def;
  return `${items.TIER_ICONS[d.tier]} ${d.emoji} **${d.name}** ×${e.qty}\n-# ${KIND_LABEL[d.kind]} · ${d.desc.slice(0, 220)}`;
}

// banner: tekst wyniku ostatniej akcji (albo null); page: numer strony (od 0); disabled: wyłącza przyciski po czasie
async function buildView(guildId, user, { banner = null, page = 0, disabled = false } = {}) {
  const [inventory, armed, luckInfo, pityMap] = await Promise.all([
    inv.getInventory(guildId, user.id),
    inv.getArmed(guildId, user.id),
    inv.getLuckBreakdown(guildId, user.id),
    inv.getAllPity(guildId, user.id),
  ]);

  const { entries, collection } = collectEntries(inventory);
  const pages = Math.max(1, Math.ceil(entries.length / ROWS_PER_PAGE));
  const current = Math.min(Math.max(page, 0), pages - 1);
  const slice = entries.slice(current * ROWS_PER_PAGE, (current + 1) * ROWS_PER_PAGE);

  const active = [];
  if (luckInfo.koniczynaLevel > 0) active.push(`🍀 Koniczyna, poziom ${luckInfo.koniczynaLevel}/${items.MAX_LEVEL}: +${luckInfo.koniczyna}%`);
  if (luckInfo.podkowaLevel > 0) active.push(`🐴 Podkowa, poziom ${luckInfo.podkowaLevel}/${items.MAX_LEVEL}: +${luckInfo.podkowa}%`);
  if (luckInfo.combo > 0) active.push(`✨ Komplet Koniczyna + Podkowa: +${luckInfo.combo}%`);
  if (luckInfo.once > 0) active.push(`🍀 Koniczynka: +${luckInfo.once}% (zużyje się przy następnej skrzyni)`);
  if (luckInfo.raw > 0) active.push(`➡️ Szczęście razem: **+${luckInfo.luck}%** (limit +${items.LUCK_CAP}%, razem z pechem)`);
  const pityLines = Object.entries(pityMap)
    .map(([source, meter]) => ({ source, bonus: items.pityBonus(meter) }))
    .filter((p) => p.bonus >= 0.1)
    .map((p) => `${p.source === 'daily' ? 'dzienna' : (items.CHESTS[p.source]?.name ?? p.source)} +${fmtPct(p.bonus)}%`);
  if (pityLines.length) active.push(`🌧️ Pech (pomoc po słabych losowaniach): ${pityLines.join(' · ')}`);
  if (armed.daily_mod) { const d = items.ITEMS[armed.daily_mod]; active.push(`${d.emoji} ${d.name}: zadziała przy następnym \`/nagroda\``); }
  if (armed.daily_item) active.push('⏰ Budzik: następna dzienna skrzynia ma większą szansę na przedmiot');
  if (armed.polisa) { const d = items.ITEMS[armed.polisa]; active.push(`${d.emoji} ${d.name}: zadziała w następnej grze w kasynie`); }

  const container = new ContainerBuilder().setAccentColor(0xd4af37);

  if (banner) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(banner));
    container.addSeparatorComponents(small());
  }

  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 🎒 Ekwipunek: ${nameOf(user)}`));

  if (active.length) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`**✨ Aktywne**\n${active.join('\n')}`));
  }

  container.addSeparatorComponents(small());

  if (entries.length === 0) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent('_Pusto. Odbierz `/nagroda` albo kup skrzynię w `/sklep`._'));
  } else {
    for (const e of slice) {
      const button = e.type === 'chest'
        ? new ButtonBuilder().setCustomId(`${OPEN_PREFIX}${e.def.id}`).setStyle(ButtonStyle.Primary).setLabel('Otwórz').setEmoji('📦')
        : isMoneyItem(e.def)
          ? new ButtonBuilder().setCustomId(`${USE_PREFIX}${e.def.id}`).setStyle(ButtonStyle.Primary).setLabel('Otwórz').setEmoji('📦')
          : new ButtonBuilder().setCustomId(`${USE_PREFIX}${e.def.id}`).setStyle(ButtonStyle.Success).setLabel('Użyj').setEmoji('✨');
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(entryText(e)))
          .setButtonAccessory(button.setDisabled(disabled)),
      );
    }
  }

  if (collection.length) {
    container.addSeparatorComponents(small());
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `**🏆 Kolekcja**\n${collection.map((d) => `${items.TIER_ICONS[d.tier]} ${d.emoji} ${d.name}`).join('\n')}`,
    ));
  }

  if (pages > 1) {
    container.addSeparatorComponents(small());
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(PREV_ID).setStyle(ButtonStyle.Secondary).setLabel('Poprzednia').setEmoji('⬅️').setDisabled(disabled || current === 0),
        new ButtonBuilder().setCustomId(PAGE_ID).setStyle(ButtonStyle.Secondary).setLabel(`${current + 1}/${pages}`).setDisabled(true),
        new ButtonBuilder().setCustomId(NEXT_ID).setStyle(ButtonStyle.Secondary).setLabel('Następna').setEmoji('➡️').setDisabled(disabled || current >= pages - 1),
      ),
    );
  }

  return { components: [container], flags: V2, page: current };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ekwipunek')
    .setDescription('Twój ekwipunek: przedmioty i skrzynie. Stąd je używasz i otwierasz.'),

  async execute(interaction) {
    const guildId = interaction.guild.id;
    const user = interaction.user;
    let page = 0;

    const first = await buildView(guildId, user, { page });
    await interaction.reply({ components: first.components, flags: V2 | MessageFlags.Ephemeral });
    const message = await interaction.fetchReply();

    // buildView zwraca też numer strony po przycięciu (np. gdy ostatnia pozycja zniknęła)
    const render = async (opts = {}) => {
      const view = await buildView(guildId, user, { page, ...opts });
      page = view.page;
      return { components: view.components, flags: V2 };
    };

    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      filter: (i) => i.user.id === user.id && i.customId.startsWith('inv_'),
      time: 5 * 60_000,
    });

    let busy = false; // jedna akcja naraz, żeby szybkie klikanie niczego nie dublowało
    collector.on('collect', async (i) => {
      await i.deferUpdate().catch(() => null);
      if (busy) return;
      busy = true;
      try {
        let banner = null;

        if (i.customId === PREV_ID) page -= 1;
        else if (i.customId === NEXT_ID) page += 1;
        else if (i.customId.startsWith(OPEN_PREFIX)) {
          const chest = items.CHESTS[i.customId.slice(OPEN_PREFIX.length)];
          banner = chest ? await openChest(interaction, guildId, user, chest) : '❌ **Nie ma takiej skrzyni**';
        } else if (i.customId.startsWith(USE_PREFIX)) {
          const itemId = i.customId.slice(USE_PREFIX.length);
          if (isMoneyItem(items.ITEMS[itemId])) {
            banner = await openMoneyItem(interaction, guildId, user, items.ITEMS[itemId]);
          } else {
            const res = await useItem(guildId, user.id, itemId);
            banner = res.ok ? `**${res.title}**\n${res.lines.join('\n')}` : `❌ **Nie udało się**\n${res.message}`;
          }
        }

        await interaction.editReply(await render({ banner }));
      } catch (err) {
        console.error('Błąd w /ekwipunek:', err);
        await interaction.editReply(await render({ banner: '❌ **Coś poszło nie tak**\nSpróbuj ponownie za chwilę. Nic nie zostało zużyte.' })).catch(() => null);
      } finally {
        busy = false;
      }
    });

    // Po 5 minutach przyciski się wyłączają (wiadomość V2 nie może zostać bez komponentów)
    collector.on('end', async () => {
      await interaction.editReply(await render({ disabled: true })).catch(() => null);
    });
  },
};

const sendToChannel = (interaction) => (payload) => interaction.channel.send(payload);
const CHANNEL_ERROR = '❌ **Nie mogę wysłać wiadomości na tym kanale**\nSprawdź uprawnienia bota. Nic nie zostało zużyte.';
const doneBanner = (emoji, name, res) => (res.ok
  ? `${emoji} **Otwarto: ${name}**\nWynik jest na kanale.`
  : `❌ **Nie udało się**\n${res.message}`);

// Otwarcie kupionej skrzyni: "Otwieranie: <nazwa>", po chwili publicznie na kanale pokazuje się zawartość (bez wyboru).
// Zwraca tekst banera.
async function openChest(interaction, guildId, user, chest) {
  const have = (await inv.getInventory(guildId, user.id)).find((r) => r.itemId === chest.id);
  if (!have) return '❌ **Nie masz już tej skrzyni**';

  const [luckInfo, owned, pity] = await Promise.all([
    inv.getLuckBreakdown(guildId, user.id),
    inv.getOwnedUnique(guildId, user.id),
    inv.getPity(guildId, user.id, chest.id),
  ]);
  const bonus = items.totalBonus(luckInfo.luck, pity); // szczęście + pech
  const rolled = items.rollChestContents(chest, bonus, owned); // { coins, item }
  // Koniczynka zużywa się przy otwarciu skrzyni; licznik pecha dotyczy tylko skrzyń ze sklepu (nie starych)
  const settleExtra = {
    consumeKinds: luckInfo.once > 0 ? ['luck_once'] : [],
    pity: chest.tiers && rolled.item ? { source: chest.id, delta: items.pityDelta(chest.id, rolled.item.value) } : null,
  };

  let res;
  try {
    res = await runOpening({
      send: sendToChannel(interaction),
      user,
      emoji: chest.emoji,
      name: chest.name,
      openDelayMs: OPEN_DELAY_MS,
      settle: async () => {
        const s = await inv.settleChestOpen(guildId, user.id, chest.id, rolled.coins, rolled.item ? [rolled.item.id] : [], settleExtra);
        if (!s.ok) return { ok: false, message: '❌ Tej skrzyni już nie ma w Twoim ekwipunku.' };

        const lines = [];
        if (rolled.coins > 0) lines.push(`Zyskujesz: ${formatCoins(rolled.coins)}`);
        if (rolled.item) {
          const level = s.levels?.[rolled.item.id];
          lines.push(s.granted.includes(rolled.item.id)
            ? `🎁 Do ekwipunku: ${rolled.item.emoji} **${rolled.item.name}**${level ? ` ⬆️ poziom ${level}/${rolled.item.maxLevel}` : ''}`
            : `ℹ️ ${rolled.item.name}: już to masz (pominięty).`);
        }
        if (!rolled.coins && !rolled.item) lines.push('W środku pusto.');
        if (rolled.coins > 0) lines.push(`Saldo: ${formatCoins(s.balance)}`);
        if (bonus > 0) lines.push(`*🍀 Bonus w tej skrzyni: +${fmtPct(bonus)}%*`);

        return {
          ok: true,
          title: `🎁 Otwarto: ${chest.name}`,
          color: DAILY_TIERS[chest.tier].color,
          lines,
          quip: TIER_QUIPS[rolled.item ? rolled.item.tier : chest.tier] ?? '', // komentarz zależy od tego, co wypadło
        };
      },
    });
  } catch (err) {
    console.error('Nie udało się wysłać skrzyni na kanał:', err.message);
    return CHANNEL_ERROR;
  }
  return doneBanner(chest.emoji, chest.name, res);
}

// Przedmiot "pieniężny" (np. Kufer Boba): to samo otwieranie co skrzynia; wynik (nic / suma / mandat) liczy useItem.
async function openMoneyItem(interaction, guildId, user, def) {
  let res;
  try {
    res = await runOpening({
      send: sendToChannel(interaction),
      user,
      emoji: def.emoji,
      name: def.name,
      openDelayMs: OPEN_DELAY_MS,
      settle: async () => {
        const used = await useItem(guildId, user.id, def.id);
        if (!used.ok) return { ok: false, message: `❌ ${used.message}` };
        return {
          ok: true,
          title: `🎁 Otwarto: ${def.name}`,
          color: used.color,
          lines: used.lines,
          quip: used.color === GAIN_COLOR ? TIER_QUIPS[def.tier] ?? '' : '', // komentarz Boba tylko przy wygranej
        };
      },
    });
  } catch (err) {
    console.error('Nie udało się wysłać wiadomości na kanał:', err.message);
    return CHANNEL_ERROR;
  }
  return doneBanner(def.emoji, def.name, res);
}
