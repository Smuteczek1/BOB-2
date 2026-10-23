const {
  SlashCommandBuilder, ContainerBuilder, SectionBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags,
} = require('discord.js');
const db = require('../db');
const inv = require('../utils/inventory');
const items = require('../utils/items');
const { formatCoins } = require('../utils/economy');

// Sklep jest zbudowany z Components V2 (Container + Section z przyciskiem obok skrzyni),
// tak samo jak panele w utils/panel.js i utils/verification.js.
const V2 = MessageFlags.IsComponentsV2;
const BUY_PREFIX = 'shop_buy:'; // shop_buy:<id_skrzyni>
const MARKET_ID = 'shop_type_market';
const COSMETICS_ID = 'shop_type_cosmetics';

const SHOP_CHESTS = () => Object.values(items.CHESTS).filter((c) => !c.legacy);

const pctText = (p) => (Number.isInteger(p) ? `${p}%` : `${p.toFixed(1).replace('.', ',')}%`);
const small = () => new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small);

// Tekst skrzyni: nazwa i cena, a pod spodem lista poziomów, które mogą wypaść
function chestText(c) {
  const lines = items.tierOdds(c).map((t) => `${items.TIER_ICONS[t.tier]} ${items.TIER_NAMES[t.tier]} · ${pctText(t.pct)}`);
  const head = c.coins
    ? `monety ${c.coins[0].toLocaleString('pl-PL')}–${c.coins[1].toLocaleString('pl-PL')} + szansa na przedmiot ${Math.round(c.itemChance * 100)}%`
    : 'zawsze wypada przedmiot';
  return `### ${c.emoji} ${c.name} · ${formatCoins(c.price)}\n-# ${head}\n${lines.join('\n')}`;
}

// banner: tekst po zakupie (albo null), disabled: wyłącza wszystkie przyciski (po upływie czasu)
async function buildView(guildId, user, banner, disabled = false) {
  const balance = Number((await db.getEconomyAccount(guildId, user.id))?.balance ?? 0);

  const container = new ContainerBuilder().setAccentColor(0xd4af37);

  if (banner) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(banner));
    container.addSeparatorComponents(small());
  }

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('## 🛒 Sklep Boba'),
    new TextDisplayBuilder().setContent(
      'Przedmiotów nie kupisz. **Wypadają ze skrzyń**, a każda skrzynia losuje z innych poziomów rzadkości. Skrzynię otwierasz w `/ekwipunek`.\n' +
      `Twoje saldo: ${formatCoins(balance)}`,
    ),
  );

  for (const c of SHOP_CHESTS()) {
    container.addSeparatorComponents(small());
    const buy = new ButtonBuilder()
      .setCustomId(`${BUY_PREFIX}${c.id}`)
      .setStyle(ButtonStyle.Success)
      .setLabel('Kup')
      .setEmoji('🛒')
      .setDisabled(disabled || balance < c.price);
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(chestText(c)))
        .setButtonAccessory(buy),
    );
  }

  // Zmiana typu sklepu: na razie zablokowane
  container.addSeparatorComponents(small());
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent('-# Zmień typ sklepu (wkrótce)'));
  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(MARKET_ID).setStyle(ButtonStyle.Secondary).setLabel('Rynek').setEmoji('🏪').setDisabled(true),
      new ButtonBuilder().setCustomId(COSMETICS_ID).setStyle(ButtonStyle.Secondary).setLabel('Kosmetyczne').setEmoji('🎨').setDisabled(true),
    ),
  );

  return { components: [container], flags: V2 };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('sklep')
    .setDescription('Sklep Boba: kup jedną z trzech skrzyń (zobacz, co w nich może być).'),

  async execute(interaction) {
    const guildId = interaction.guild.id;
    const user = interaction.user;

    await interaction.reply({ ...(await buildView(guildId, user, null)), flags: V2 | MessageFlags.Ephemeral });
    const message = await interaction.fetchReply();

    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      filter: (i) => i.user.id === user.id && i.customId.startsWith(BUY_PREFIX),
      time: 5 * 60_000,
    });

    let busy = false; // jedna akcja naraz, żeby szybkie klikanie nie kupiło dwa razy
    collector.on('collect', async (i) => {
      await i.deferUpdate().catch(() => null);
      if (busy) return;
      busy = true;
      try {
        const chest = items.CHESTS[i.customId.slice(BUY_PREFIX.length)];
        let banner;
        if (!chest || chest.legacy) {
          banner = '❌ **Ta skrzynia nie jest dostępna w sklepie.**';
        } else {
          const res = await inv.buyChest(guildId, user.id, chest.id);
          banner = res.ok
            ? `✅ **Kupiono: ${chest.emoji} ${chest.name}**\nSkrzynia czeka w \`/ekwipunek\`. Saldo: ${formatCoins(res.balance)}`
            : `❌ **Za mało monet**\n${chest.name} kosztuje ${formatCoins(chest.price)}.`;
        }
        await interaction.editReply(await buildView(guildId, user, banner));
      } catch (err) {
        console.error('Błąd w /sklep:', err);
        await interaction.editReply(await buildView(guildId, user, '❌ **Coś poszło nie tak**\nNic nie zostało pobrane. Spróbuj ponownie.')).catch(() => null);
      } finally {
        busy = false;
      }
    });

    // Po 5 minutach przyciski się wyłączają (wiadomość V2 nie może zostać bez komponentów)
    collector.on('end', async () => {
      await interaction.editReply(await buildView(guildId, user, null, true)).catch(() => null);
    });
  },
};
