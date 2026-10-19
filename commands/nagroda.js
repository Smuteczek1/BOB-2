const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
} = require('discord.js');
const db = require('../db');
const { rollDailyReward, formatCoins, CURRENCY, DAILY_TIERS } = require('../utils/economy');

// Ile czasu (ms) masz na wybór skrzyni i jak długo trwa etap "otwieranie". Zmiana w .env: CHEST_PICK_TIME_MS / CHEST_FRAME_DELAY_MS
const PICK_TIME_MS = Number(process.env.CHEST_PICK_TIME_MS ?? 60_000);
const OPEN_DELAY_MS = Number(process.env.CHEST_FRAME_DELAY_MS ?? 2000);
const CHEST_COUNT = 3;

// Ikona rzadkości = pierwszy "wyraz" nazwy, np. "⚪ Pospolita Skrzynia" -> "⚪"
const tierIcon = (tier) => tier.name.split(' ')[0];

// Komentarz Boba do każdej rzadkości (kolejność jak w DAILY_TIERS)
const BOB_QUIPS = [
  'Bywało gorzej. Ja kiedyś dostawałem same puste butelki.',
  'Przyzwoicie, starczy na porządną kolację.',
  'O, niezłe! Postaw koledze kolejkę, nie bądź skąpy.',
  'Legendarna! Takie rzeczy się pamięta latami.',
  'MITYCZNA?! Chowaj to szybko, zanim ja to zobaczę!',
  'Boska skrzynia... Przysięgam, że dzisiaj nie piłem.',
  'VOID. Czegoś takiego nie widziałem nigdy. Nikomu nie mów.',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nameOf = (user) => user.displayName ?? user.username;

// Przyciski wyboru (etap 1)
function pickRow(disabled = false, selected = null) {
  const row = new ActionRowBuilder();
  for (let i = 0; i < CHEST_COUNT; i++) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`chest_${i}`)
        .setLabel(`Skrzynia ${i + 1}`)
        .setEmoji('📦')
        .setStyle(selected === i ? ButtonStyle.Success : ButtonStyle.Primary)
        .setDisabled(disabled),
    );
  }
  return row;
}

// Przyciski po otwarciu (etap 3): każdy pokazuje, co było w środku, wybrana jest zielona
function revealRow(chests, selected) {
  const row = new ActionRowBuilder();
  chests.forEach((c, i) => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`chest_${i}`)
        .setLabel(`${tierIcon(c.tier)} ${c.amount.toLocaleString('pl-PL')}`)
        .setStyle(i === selected ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(true),
    );
  });
  return row;
}

function pickEmbed(user) {
  return new EmbedBuilder()
    .setColor(0x7a5420)
    .setTitle('🎁 Dzienna skrzynia: wybierz jedną z trzech!')
    .setDescription(
      '📦 Bob stawia na ladzie **trzy skrzynie** i patrzy spod oka.\n' +
      'W każdej jest inna nagroda. Którą otwierasz?\n\n' +
      `# ⬛ ⬛ ⬛`,
    )
    .setFooter({ text: `Etap 1/3 • wybiera: ${nameOf(user)} • masz ${Math.round(PICK_TIME_MS / 1000)} s` });
}

function openingEmbed(user, index) {
  return new EmbedBuilder()
    .setColor(0xd4af37)
    .setTitle('🎁 Dzienna skrzynia')
    .setDescription(
      `🔒 Skrzynia **${index + 1}**: zamek trzeszczy, wieko drży, a spod niego przebija się światło... ✨\n\n` +
      `# ${[0, 1, 2].map((i) => (i === index ? '✨' : '⬛')).join(' ')}`,
    )
    .setFooter({ text: `Etap 2/3 • otwiera: ${nameOf(user)}` });
}

function revealEmbed(user, chests, selected, balance) {
  const chosen = chests[selected];
  const tierIndex = DAILY_TIERS.indexOf(chosen.tier);
  const isBig = tierIndex >= 4; // Mityczna i wyżej

  const others = chests
    .map((c, i) => ({ c, i }))
    .filter(({ i }) => i !== selected)
    .map(({ c, i }) => `Skrzynia ${i + 1}: ${c.tier.name} (${formatCoins(c.amount)})`)
    .join('\n');

  const bestOther = Math.max(...chests.filter((_, i) => i !== selected).map((c) => c.amount));
  const regret =
    chosen.amount >= bestOther
      ? '🏆 Wybrałeś/aś najlepszą skrzynię!'
      : `😬 W innej skrzyni było więcej (o ${(bestOther - chosen.amount).toLocaleString('pl-PL')}).`;

  return new EmbedBuilder()
    .setColor(chosen.tier.color)
    .setTitle(isBig ? '🎆 NIESAMOWITE! 🎆' : '🎁 Skrzynia otwarta!')
    .setDescription(
      `**KLIK!** W skrzyni **${selected + 1}** wypadło: **${chosen.tier.name}**\n\n` +
      `${CURRENCY.emoji} Nagroda: ${formatCoins(chosen.amount)}\n` +
      `Saldo: ${formatCoins(balance)}\n\n` +
      `**W pozostałych było:**\n${others}\n${regret}\n\n` +
      `🥃 *Bob: ${BOB_QUIPS[tierIndex] ?? ''}*`,
    )
    .setFooter({ text: `Etap 3/3 • otworzył(a): ${nameOf(user)} • kolejna skrzynia jutro po 00:00` })
    .setTimestamp();
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('nagroda')
    .setDescription('Odbierz dzienną nagrodę: wybierz jedną z trzech skrzyń (reset o północy, czas polski)!'),

  async execute(interaction) {
    const guildId = interaction.guild.id;
    const user = interaction.user;
    const noPings = { parse: [] };

    // Szybkie sprawdzenie na starcie, żeby nie pokazywać skrzyń komuś, kto już dziś odebrał.
    // (Prawdziwe, atomowe sprawdzenie i tak następuje w bazie w momencie wyboru.)
    if (!(await db.canClaimDaily(guildId, user.id))) {
      await interaction.reply({
        content: '⏰ Odebrałeś/aś już dzisiejszą skrzynię! Wróć po północy (00:00).',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Zawartość wszystkich trzech skrzyń losujemy z góry (kryptograficznym RNG).
    // Wszystkie losowania są niezależne i identyczne, więc wybór skrzyni nie wpływa na średnią nagrodę.
    const chests = Array.from({ length: CHEST_COUNT }, () => rollDailyReward());

    await interaction.reply({
      content: `${user} stoi przed trzema skrzyniami!`,
      embeds: [pickEmbed(user)],
      components: [pickRow()],
      allowedMentions: noPings,
    });
    const message = await interaction.fetchReply();

    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: PICK_TIME_MS,
    });

    let picked = false; // ustawiane synchronicznie, więc szybkie podwójne kliknięcie nie otworzy dwóch skrzyń

    collector.on('collect', async (click) => {
      // Cudze kliknięcia: tylko krótka, prywatna odpowiedź
      if (click.user.id !== user.id) {
        await click.reply({
          content: 'To nie Twoja skrzynia! Wpisz własne `/nagroda`. 😉',
          flags: MessageFlags.Ephemeral,
        }).catch(() => null);
        return;
      }
      if (picked) {
        await click.deferUpdate().catch(() => null);
        return;
      }
      picked = true;

      const selected = Number(click.customId.replace('chest_', ''));
      collector.stop('picked');

      // Etap 2/3: natychmiastowa odpowiedź na kliknięcie
      await click.update({
        content: `${user} otwiera skrzynię **${selected + 1}**!`,
        embeds: [openingEmbed(user, selected)],
        components: [pickRow(true, selected)],
        allowedMentions: noPings,
      }).catch((err) => console.error('Skrzynia: etap 2 nie powiódł się:', err.message));

      // Wypłata: atomowo w bazie. Dopiero tu "zużywa się" dzienna nagroda.
      const chosen = chests[selected];
      let result;
      try {
        result = await db.claimDailyCoins(guildId, user.id, chosen.amount);
      } catch (err) {
        console.error('Skrzynia: błąd wypłaty:', err);
        await interaction.editReply({
          content: '❌ Coś poszło nie tak przy wypłacie. Nagroda **nie** została pobrana, spróbuj za chwilę ponownie.',
          embeds: [],
          components: [],
        }).catch(() => null);
        return;
      }

      if (!result.claimed) {
        // Np. druga równoległa sesja zdążyła pierwsza
        await interaction.editReply({
          content: '⏰ Dzisiejsza nagroda została już odebrana. Wróć po północy (00:00).',
          embeds: [],
          components: [],
        }).catch(() => null);
        return;
      }

      await sleep(OPEN_DELAY_MS);

      // Etap 3/3: odsłonięcie nagrody i zawartości pozostałych skrzyń
      const tierIndex = DAILY_TIERS.indexOf(chosen.tier);
      const payload = {
        content: tierIndex >= 4 ? `🎉 ${user} wylosował(a) **${chosen.tier.name}**!` : `${user}`,
        embeds: [revealEmbed(user, chests, selected, result.balance)],
        components: [revealRow(chests, selected)],
        allowedMentions: noPings,
      };
      try {
        await interaction.editReply(payload);
      } catch {
        // Wiadomość mogła zostać usunięta. Nagroda jest już przyznana, więc pokazujemy wynik osobno.
        await interaction.followUp(payload).catch((err) => console.error('Skrzynia: nie pokazano nagrody:', err.message));
      }
    });

    collector.on('end', async (_collected, reason) => {
      if (reason === 'picked') return;
      // Nikt nie kliknął: skrzynie znikają, a dzienna nagroda NIE została zużyta
      await interaction.editReply({
        content: '⌛ Skrzynie zniknęły, bo nie wybrałeś/aś żadnej. Dzienna nagroda **nie** została zużyta, wpisz `/nagroda` ponownie.',
        embeds: [],
        components: [],
      }).catch(() => null);
    });
  },
};
