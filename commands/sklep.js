const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
} = require('discord.js');
const db = require('../db');
const inv = require('../utils/inventory');
const items = require('../utils/items');
const { formatCoins } = require('../utils/economy');

const SELECT_ID = 'shop_select';
const BUY_ID = 'shop_buy';

const chestDescription = (c) =>
  c.itemOnly
    ? `tylko przedmiot (poziom ${items.TIER_NAMES[c.tier]})`
    : `monety ${c.coins[0].toLocaleString('pl-PL')}–${c.coins[1].toLocaleString('pl-PL')} · szansa na przedmiot ${Math.round(c.itemChance * 100)}% (poziom ${items.TIER_NAMES[c.tier]})`;

async function buildView(guildId, user, selectedId, banner) {
  const balance = Number((await db.getEconomyAccount(guildId, user.id))?.balance ?? 0);
  const all = Object.values(items.CHESTS);
  const selected = selectedId ? items.CHESTS[selectedId] : null;

  const list = new EmbedBuilder()
    .setColor(0xd4af37)
    .setTitle('🛒 Sklep Boba')
    .setDescription(
      'Przedmioty nie są na sprzedaż: **wypadają ze skrzyń**. Tu kupujesz skrzynie, a otwierasz je w `/ekwipunek`.\n' +
      `Twoje saldo: ${formatCoins(balance)}\n\n` +
      all.map((c) => `${c.emoji} **${c.name}** · ${formatCoins(c.price)}\n└ ${chestDescription(c)}`).join('\n') +
      '\n\n_Kolory nicków dojdą wkrótce._',
    );

  const select = new StringSelectMenuBuilder()
    .setCustomId(SELECT_ID)
    .setPlaceholder('Wybierz skrzynię do kupienia...')
    .addOptions(all.map((c) => ({
      label: `${c.name} (${c.price.toLocaleString('pl-PL')})`.slice(0, 100),
      value: c.id,
      emoji: c.emoji,
      description: chestDescription(c).slice(0, 100),
      default: c.id === selectedId,
    })));

  const buy = new ButtonBuilder()
    .setCustomId(BUY_ID)
    .setStyle(ButtonStyle.Success)
    .setLabel(selected ? `Kup za ${selected.price.toLocaleString('pl-PL')}` : 'Najpierw wybierz skrzynię')
    .setDisabled(!selected || balance < (selected?.price ?? 0));

  const embeds = banner ? [banner, list] : [list];
  return { embeds, components: [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(buy)] };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('sklep')
    .setDescription('Sklep Boba: kup skrzynię z monetami i przedmiotami.'),

  async execute(interaction) {
    const guildId = interaction.guild.id;
    const user = interaction.user;
    let selectedId = null;

    await interaction.reply({ ...(await buildView(guildId, user, selectedId, null)), flags: MessageFlags.Ephemeral });
    const message = await interaction.fetchReply();

    const collector = message.createMessageComponentCollector({
      filter: (i) => i.user.id === user.id && (i.customId === SELECT_ID || i.customId === BUY_ID),
      time: 5 * 60_000,
    });

    let busy = false;
    collector.on('collect', async (i) => {
      await i.deferUpdate().catch(() => null);
      if (busy) return;
      busy = true;
      try {
        let banner = null;
        if (i.customId === SELECT_ID) {
          selectedId = i.values[0];
        } else if (i.customId === BUY_ID && selectedId) {
          const chest = items.CHESTS[selectedId];
          const res = await inv.buyChest(guildId, user.id, selectedId);
          banner = res.ok
            ? new EmbedBuilder().setColor(0x2ecc71).setTitle(`✅ Kupiono: ${chest.emoji} ${chest.name}`).setDescription(`Skrzynia czeka w \`/ekwipunek\`. Saldo: ${formatCoins(res.balance)}`)
            : new EmbedBuilder().setColor(0xe74c3c).setTitle('❌ Za mało monet').setDescription(`${chest.name} kosztuje ${formatCoins(chest.price)}.`);
        }
        await interaction.editReply(await buildView(guildId, user, selectedId, banner));
      } catch (err) {
        console.error('Błąd w /sklep:', err);
        await interaction.editReply(await buildView(guildId, user, selectedId, new EmbedBuilder().setColor(0xe74c3c).setTitle('❌ Coś poszło nie tak').setDescription('Nic nie zostało pobrane. Spróbuj ponownie.'))).catch(() => null);
      } finally {
        busy = false;
      }
    });

    collector.on('end', async () => { await interaction.editReply({ components: [] }).catch(() => null); });
  },
};
