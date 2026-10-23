const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ComponentType, MessageFlags,
} = require('discord.js');
const db = require('../db');
const inv = require('../utils/inventory');
const items = require('../utils/items');
const { useItem } = require('../utils/itemUse');
const { runChestGame, TIER_QUIPS } = require('../utils/chestGame');
const { DAILY_TIERS, formatCoins } = require('../utils/economy');

const PICK_TIME_MS = Number(process.env.CHEST_PICK_TIME_MS ?? 60_000);
const OPEN_DELAY_MS = Number(process.env.CHEST_FRAME_DELAY_MS ?? 2000);
const MENU_ID = 'inv_use';
const KIND_TAG = { consumable: 'J', permanent: 'S', collectible: 'K' };

const minutesLeft = (ms) => Math.max(1, Math.ceil((ms - Date.now()) / 60000));
const nameOf = (user) => user.displayName ?? user.username;

async function buildView(guildId, user, banner) {
  const [inventory, boosts, armed, luck] = await Promise.all([
    inv.getInventory(guildId, user.id),
    inv.getBoosts(guildId, user.id),
    inv.getArmed(guildId, user.id),
    inv.getLuck(guildId, user.id),
  ]);

  const chestRows = inventory.filter((i) => items.isChest(i.itemId));
  const itemRows = inventory
    .filter((i) => !items.isChest(i.itemId) && items.ITEMS[i.itemId])
    .sort((a, b) => items.ITEMS[b.itemId].tier - items.ITEMS[a.itemId].tier);

  const chestLines = chestRows.map((r) => `${items.CHESTS[r.itemId].emoji} **${items.CHESTS[r.itemId].name}** ×${r.quantity}`);
  const itemLines = itemRows.map((r) => {
    const d = items.ITEMS[r.itemId];
    return `${items.TIER_ICONS[d.tier]} ${d.emoji} **${d.name}** ×${r.quantity} · ${KIND_TAG[d.kind]}`;
  });

  const active = [];
  for (const b of boosts) active.push(`🍀 Szczęście (${b.family}): +${b.value}% · jeszcze ok. ${minutesLeft(b.expiresAt)} min`);
  if (boosts.length) active.push(`➡️ Razem: **+${luck}%** (limit +${items.LUCK_CAP}%)`);
  if (armed.daily_mod) { const d = items.ITEMS[armed.daily_mod]; active.push(`${d.emoji} ${d.name}: zadziała przy następnym \`/nagroda\``); }
  if (armed.daily_item) active.push('⏰ Budzik: następna dzienna skrzynia ma większą szansę na przedmiot');
  if (armed.polisa) { const d = items.ITEMS[armed.polisa]; active.push(`${d.emoji} ${d.name}: zadziała w następnej grze w kasynie`); }

  const main = new EmbedBuilder()
    .setColor(0xd4af37)
    .setAuthor({ name: `Ekwipunek: ${nameOf(user)}`, iconURL: user.displayAvatarURL?.() })
    .addFields(
      { name: '📦 Skrzynie', value: chestLines.join('\n') || '_Brak. Kupisz je w `/sklep`._' },
      { name: '🎁 Przedmioty', value: itemLines.join('\n') || '_Pusto. Odbierz `/nagroda` albo otwórz skrzynię!_' },
    )
    .setFooter({ text: 'J = jednorazowy · S = stały · K = kolekcjonerski' });
  if (active.length) main.addFields({ name: '✨ Aktywne', value: active.join('\n') });

  // Menu: skrzynie najpierw, potem przedmioty od najwyższego poziomu (limit Discorda: 25 pozycji)
  const options = [
    ...chestRows.map((r) => {
      const c = items.CHESTS[r.itemId];
      return { label: `Otwórz: ${c.name} ×${r.quantity}`.slice(0, 100), value: c.id, emoji: c.emoji, description: 'Wybierzesz jedną z trzech skrzyń (publicznie na kanale).' };
    }),
    ...itemRows.filter((r) => items.ITEMS[r.itemId].kind !== 'collectible').map((r) => {
      const d = items.ITEMS[r.itemId];
      return { label: `Użyj: ${d.name} ×${r.quantity}`.slice(0, 100), value: d.id, emoji: d.emoji, description: d.desc.slice(0, 100) };
    }),
  ].slice(0, 25);

  const components = options.length
    ? [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(MENU_ID).setPlaceholder('Użyj przedmiotu albo otwórz skrzynię...').addOptions(options))]
    : [];

  const embeds = [];
  if (banner) embeds.push(banner);
  embeds.push(main);
  return { embeds, components };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ekwipunek')
    .setDescription('Twój ekwipunek: przedmioty i skrzynie. Stąd je używasz i otwierasz.'),

  async execute(interaction) {
    const guildId = interaction.guild.id;
    const user = interaction.user;

    await interaction.reply({ ...(await buildView(guildId, user, null)), flags: MessageFlags.Ephemeral });
    const message = await interaction.fetchReply();

    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.StringSelect,
      filter: (i) => i.user.id === user.id && i.customId === MENU_ID,
      time: 5 * 60_000,
    });

    let busy = false; // jedna akcja naraz, żeby szybkie klikanie niczego nie dublowało
    collector.on('collect', async (sel) => {
      await sel.deferUpdate().catch(() => null);
      if (busy) return;
      busy = true;
      try {
        const itemId = sel.values[0];
        let banner;

        if (items.isChest(itemId)) {
          banner = await openChest(interaction, guildId, user, items.CHESTS[itemId]);
        } else {
          const res = await useItem(guildId, user.id, itemId);
          banner = res.ok
            ? new EmbedBuilder().setColor(res.color).setTitle(res.title).setDescription(res.lines.join('\n'))
            : new EmbedBuilder().setColor(0xe74c3c).setTitle('❌ Nie udało się').setDescription(res.message);
        }
        await interaction.editReply(await buildView(guildId, user, banner));
      } catch (err) {
        console.error('Błąd w /ekwipunek:', err);
        await interaction.editReply(await buildView(guildId, user, new EmbedBuilder().setColor(0xe74c3c).setTitle('❌ Coś poszło nie tak').setDescription('Spróbuj ponownie za chwilę. Nic nie zostało zużyte.'))).catch(() => null);
      } finally {
        busy = false;
      }
    });

    collector.on('end', async () => {
      await interaction.editReply({ components: [] }).catch(() => null);
    });
  },
};

// Otwarcie kupionej skrzyni: publiczna gra "trzy skrzynie" na kanale
async function openChest(interaction, guildId, user, chest) {
  const have = (await inv.getInventory(guildId, user.id)).find((r) => r.itemId === chest.id);
  if (!have) return new EmbedBuilder().setColor(0xe74c3c).setTitle('❌ Nie masz już tej skrzyni');

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
      quip: () => TIER_QUIPS[chest.tier] ?? '',
      settle: async (selected) => {
        const c = chests[selected];
        const res = await inv.settleChestOpen(guildId, user.id, chest.id, c.coins, c.item ? [c.item.id] : []);
        if (!res.ok) return { ok: false, message: '❌ Tej skrzyni już nie ma w Twoim ekwipunku.' };
        return { ok: true, balance: res.balance, granted: res.granted };
      },
    });
  } catch (err) {
    console.error('Nie udało się wysłać skrzyni na kanał:', err.message);
    return new EmbedBuilder().setColor(0xe74c3c).setTitle('❌ Nie mogę wysłać wiadomości na tym kanale').setDescription('Sprawdź uprawnienia bota. Skrzynia nie została zużyta.');
  }
  return new EmbedBuilder().setColor(0x2ecc71).setTitle(`${chest.emoji} Skrzynie czekają na kanale`).setDescription('Wybierz jedną z trzech w publicznej wiadomości. Skrzynia zużyje się dopiero po wyborze.');
}
