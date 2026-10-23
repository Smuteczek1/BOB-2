const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const db = require('../db');
const inv = require('../utils/inventory');
const items = require('../utils/items');
const { rollDailyReward, DAILY_TIERS } = require('../utils/economy');
const { runChestGame, TIER_QUIPS } = require('../utils/chestGame');

// Czas na wybór skrzyni i długość etapu "otwieranie" (.env: CHEST_PICK_TIME_MS / CHEST_FRAME_DELAY_MS)
const PICK_TIME_MS = Number(process.env.CHEST_PICK_TIME_MS ?? 60_000);
const OPEN_DELAY_MS = Number(process.env.CHEST_FRAME_DELAY_MS ?? 2000);

module.exports = {
  data: new SlashCommandBuilder()
    .setName('nagroda')
    .setDescription('Odbierz dzienną nagrodę: wybierz jedną z trzech skrzyń (reset o północy, czas polski)!'),

  async execute(interaction) {
    const guildId = interaction.guild.id;
    const user = interaction.user;

    // Szybkie sprawdzenie na starcie (prawdziwe, atomowe sprawdzenie następuje w bazie przy wyborze)
    if (!(await db.canClaimDaily(guildId, user.id))) {
      await interaction.reply({
        content: '⏰ Odebrałeś/aś już dzisiejszą skrzynię! Wróć po północy (00:00).',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const [luck, armed, owned] = await Promise.all([
      inv.getLuck(guildId, user.id),
      inv.getArmed(guildId, user.id),
      inv.getOwnedUnique(guildId, user.id),
    ]);

    // Jeden modyfikator skrzyni na odbiór: Latarka albo Zapasowy klucz
    const modifier = armed.daily_mod === 'latarka' ? 'latarka' : armed.daily_mod === 'klucz' ? 'klucz' : null;
    const itemChance = armed.daily_item ? items.DAILY_ITEM_CHANCE_BUDZIK : items.DAILY_ITEM_CHANCE;

    // Zawartość wszystkich trzech skrzyń losujemy z góry (kryptograficznym RNG).
    // Skrzynie są niezależne i takie same, więc wybór skrzyni nie zmienia średniej nagrody.
    const makeChest = () => {
      const reward = items.luckyPick(rollDailyReward, (r) => r.amount, luck);
      const hasItem = items.chance(Math.min(1, itemChance * (1 + luck / 100)));
      const item = hasItem ? items.dropDailyItem(owned) : null;
      return {
        coins: reward.amount,
        item,
        score: reward.amount + (item ? item.value : 0),
        label: reward.tier.name,
        color: reward.tier.color,
        tierIndex: DAILY_TIERS.indexOf(reward.tier),
      };
    };
    const chests = [makeChest(), makeChest(), makeChest()];

    const consumeKinds = [];
    if (modifier) consumeKinds.push('daily_mod');
    if (armed.daily_item) consumeKinds.push('daily_item');

    await runChestGame({
      send: async (payload) => { await interaction.reply(payload); return interaction.fetchReply(); },
      edit: (payload) => interaction.editReply(payload),
      user,
      chests,
      modifier,
      luck,
      title: '🎁 Dzienna skrzynia',
      pickTimeMs: PICK_TIME_MS,
      openDelayMs: OPEN_DELAY_MS,
      quip: (chest) => TIER_QUIPS[chest.tierIndex] ?? '',
      settle: async (selected, extra) => {
        const coins = chests[selected].coins + (extra !== null ? chests[extra].coins : 0);
        const itemIds = [chests[selected].item, extra !== null ? chests[extra].item : null].filter(Boolean).map((i) => i.id);
        const result = await inv.claimDailyBundle(guildId, user.id, coins, itemIds, consumeKinds);
        if (!result.claimed) return { ok: false, message: '⏰ Dzisiejsza nagroda została już odebrana. Wróć po północy (00:00).' };
        return { ok: true, balance: result.balance, granted: result.granted };
      },
    });
  },
};
