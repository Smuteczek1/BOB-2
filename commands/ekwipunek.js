const {
  SlashCommandBuilder, ContainerBuilder, SectionBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags,
} = require('discord.js');
const inv = require('../utils/inventory');
const items = require('../utils/items');
const { useItem } = require('../utils/itemUse');
const { runChestGame, TIER_QUIPS } = require('../utils/chestGame');
const { DAILY_TIERS } = require('../utils/economy');

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

const minutesLeft = (ms) => Math.max(1, Math.ceil((ms - Date.now()) / 60000));
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
    .filter((r) => items.ITEMS[r.itemId].kind !== 'collectible')
    .map((r) => ({ type: 'item', def: items.ITEMS[r.itemId], qty: r.quantity }));
  const collection = owned
    .filter((r) => items.ITEMS[r.itemId].kind === 'collectible')
    .map((r) => items.ITEMS[r.itemId]);
  return { entries: [...chests, ...usable], collection };
}

function entryText(e) {
  if (e.type === 'chest') {
    return `${e.def.emoji} **${e.def.name}** ×${e.qty}\n-# wybierzesz jedną z trzech skrzyń (publicznie na kanale)`;
  }
  const d = e.def;
  return `${items.TIER_ICONS[d.tier]} ${d.emoji} **${d.name}** ×${e.qty}\n-# ${KIND_LABEL[d.kind]} · ${d.desc.slice(0, 220)}`;
}

// banner: tekst wyniku ostatniej akcji (albo null); page: numer strony (od 0); disabled: wyłącza przyciski po czasie
async function buildView(guildId, user, { banner = null, page = 0, disabled = false } = {}) {
  const [inventory, boosts, armed, luck] = await Promise.all([
    inv.getInventory(guildId, user.id),
    inv.getBoosts(guildId, user.id),
    inv.getArmed(guildId, user.id),
    inv.getLuck(guildId, user.id),
  ]);

  const { entries, collection } = collectEntries(inventory);
  const pages = Math.max(1, Math.ceil(entries.length / ROWS_PER_PAGE));
  const current = Math.min(Math.max(page, 0), pages - 1);
  const slice = entries.slice(current * ROWS_PER_PAGE, (current + 1) * ROWS_PER_PAGE);

  const active = [];
  for (const b of boosts) active.push(`🍀 Szczęście (${b.family}): +${b.value}% · jeszcze ok. ${minutesLeft(b.expiresAt)} min`);
  if (boosts.length) active.push(`➡️ Razem: **+${luck}%** (limit +${items.LUCK_CAP}%)`);
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
          const res = await useItem(guildId, user.id, i.customId.slice(USE_PREFIX.length));
          banner = res.ok ? `**${res.title}**\n${res.lines.join('\n')}` : `❌ **Nie udało się**\n${res.message}`;
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

// Otwarcie kupionej skrzyni: publiczna gra "trzy skrzynie" na kanale. Zwraca tekst banera.
async function openChest(interaction, guildId, user, chest) {
  const have = (await inv.getInventory(guildId, user.id)).find((r) => r.itemId === chest.id);
  if (!have) return '❌ **Nie masz już tej skrzyni**';

  const [luck, owned] = await Promise.all([inv.getLuck(guildId, user.id), inv.getOwnedUnique(guildId, user.id)]);
  const color = DAILY_TIERS[chest.tier].color;
  const chests = [0, 1, 2].map(() => {
    const r = items.rollChestContents(chest, luck, owned);
    return { coins: r.coins, item: r.item, score: r.coins + (r.item ? r.item.value : 0), label: '', color };
  });

  try {
    await runChestGame({
      send: (payload) => interaction.channel.send(payload),
      user,
      chests,
      modifier: null,
      luck,
      title: `${chest.emoji} ${chest.name}`,
      pickTimeMs: PICK_TIME_MS,
      openDelayMs: OPEN_DELAY_MS,
      quip: (c) => TIER_QUIPS[c.item ? c.item.tier : chest.tier] ?? '', // komentarz zależy od tego, co wypadło
      settle: async (selected) => {
        const c = chests[selected];
        const res = await inv.settleChestOpen(guildId, user.id, chest.id, c.coins, c.item ? [c.item.id] : []);
        if (!res.ok) return { ok: false, message: '❌ Tej skrzyni już nie ma w Twoim ekwipunku.' };
        return { ok: true, balance: res.balance, granted: res.granted };
      },
    });
  } catch (err) {
    console.error('Nie udało się wysłać skrzyni na kanał:', err.message);
    return '❌ **Nie mogę wysłać wiadomości na tym kanale**\nSprawdź uprawnienia bota. Skrzynia nie została zużyta.';
  }
  return `${chest.emoji} **Skrzynie czekają na kanale**\nWybierz jedną z trzech w publicznej wiadomości. Skrzynia zużyje się dopiero po wyborze.`;
}
