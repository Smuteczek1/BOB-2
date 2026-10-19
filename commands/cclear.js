const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');

const MAX_CLEAR_COUNT = 1000; // zabezpieczenie przed przypadkowym "usuń 1000000"

const TIME_WINDOWS = {
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '3h': 3 * 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('cclear')
    .setDescription('Czyszczenie wiadomości na czacie.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand(sub =>
      sub.setName('kanal')
        .setDescription('Usuwa wiadomości z BIEŻĄCEGO kanału.')
        .addStringOption(opt =>
          opt.setName('ilosc')
            .setDescription('Ile wiadomości usunąć - liczba (np. 10, 50) albo "all" dla wszystkich')
            .setRequired(true))
        .addUserOption(opt =>
          opt.setName('uzytkownik')
            .setDescription('Usuń tylko wiadomości tego użytkownika (opcjonalnie)')
            .setRequired(false)))
    .addSubcommand(sub =>
      sub.setName('uzytkownik')
        .setDescription('Usuwa wiadomości danego użytkownika ze WSZYSTKICH kanałów serwera, z danego okresu.')
        .addUserOption(opt =>
          opt.setName('uzytkownik')
            .setDescription('Czyje wiadomości usunąć')
            .setRequired(true))
        .addStringOption(opt =>
          opt.setName('okres')
            .setDescription('Z jakiego okresu czasu wstecz')
            .setRequired(true)
            .addChoices(
              { name: '30 minut', value: '30m' },
              { name: '1 godzina', value: '1h' },
              { name: '3 godziny', value: '3h' },
              { name: '6 godzin', value: '6h' },
              { name: '12 godzin', value: '12h' },
              { name: '24 godziny (dzień)', value: '24h' },
            ))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'kanal') return handleChannelClear(interaction);
    if (sub === 'uzytkownik') return handleUserWideClear(interaction);
  },
};

async function handleChannelClear(interaction) {
  const iloscRaw = interaction.options.getString('ilosc').trim().toLowerCase();
  const userFilter = interaction.options.getUser('uzytkownik');

  let targetCount;
  if (iloscRaw === 'all' || iloscRaw === 'wszystko') {
    targetCount = Infinity;
  } else {
    const parsed = parseInt(iloscRaw, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      await interaction.reply({ content: '⚠️ Podaj poprawną liczbę (np. 10) albo "all".', ephemeral: true });
      return;
    }
    targetCount = Math.min(parsed, MAX_CLEAR_COUNT);
  }

  await interaction.deferReply({ ephemeral: true });

  const deletedTotal = await clearChannelMessages(interaction.channel, targetCount, userFilter);

  await interaction.editReply({
    content:
      `🧹 Usunięto **${deletedTotal}** wiadomości z <#${interaction.channel.id}>` +
      (userFilter ? ` (autor: **${userFilter.username}**)` : '') +
      (deletedTotal < targetCount && targetCount !== Infinity
        ? '\n⚠️ Nie udało się usunąć tylu, ile prosiłeś — prawdopodobnie kanał się skończył albo część wiadomości ma ponad 14 dni (Discord nie pozwala ich masowo usuwać).'
        : ''),
  });
}

async function handleUserWideClear(interaction) {
  const userFilter = interaction.options.getUser('uzytkownik');
  const okres = interaction.options.getString('okres');
  const windowMs = TIME_WINDOWS[okres];

  await interaction.deferReply({ ephemeral: true });

  const cutoffTimestamp = Date.now() - windowMs;
  const deletedTotal = await clearUserMessagesGuildWide(interaction.guild, userFilter, cutoffTimestamp);

  await interaction.editReply({
    content: `🧹 Usunięto **${deletedTotal}** wiadomości użytkownika **${userFilter.username}** ze wszystkich kanałów (ostatnie ${describeWindow(okres)}).`,
  });
}

function describeWindow(code) {
  const map = {
    '30m': '30 minut',
    '1h': '1 godzinę',
    '3h': '3 godziny',
    '6h': '6 godzin',
    '12h': '12 godzin',
    '24h': '24 godziny',
  };
  return map[code] ?? code;
}

// Usuwa wiadomości z jednego kanału, idąc wstecz (paginacja przez "before"),
// opcjonalnie filtrując po autorze. Zwraca liczbę faktycznie usuniętych wiadomości.
async function clearChannelMessages(channel, targetCount, userFilter) {
  let deletedTotal = 0;
  let beforeId;
  let exhausted = false;

  while (deletedTotal < targetCount && !exhausted) {
    const fetched = await channel.messages.fetch({ limit: 100, before: beforeId }).catch(() => null);
    if (!fetched || fetched.size === 0) break;

    beforeId = fetched.last().id;

    const candidates = userFilter ? fetched.filter(m => m.author.id === userFilter.id) : fetched;

    if (candidates.size > 0) {
      const remaining = targetCount === Infinity ? candidates.size : targetCount - deletedTotal;
      const toDelete = [...candidates.values()].slice(0, remaining);
      const result = await channel.bulkDelete(toDelete, true).catch(() => null);
      deletedTotal += result ? result.size : 0;
    }

    if (fetched.size < 100) exhausted = true;
  }

  return deletedTotal;
}

// Usuwa wiadomości danego użytkownika ze WSZYSTKICH kanałów tekstowych serwera,
// ograniczając się do wiadomości nowszych niż cutoffTimestamp.
async function clearUserMessagesGuildWide(guild, userFilter, cutoffTimestamp) {
  let deletedTotal = 0;

  const channels = guild.channels.cache.filter(c =>
    c.isTextBased?.() && c.type !== ChannelType.GuildCategory,
  );

  for (const channel of channels.values()) {
    try {
      let beforeId;
      let stop = false;

      while (!stop) {
        const fetched = await channel.messages.fetch({ limit: 100, before: beforeId }).catch(() => null);
        if (!fetched || fetched.size === 0) break;

        beforeId = fetched.last().id;

        const inWindow = fetched.filter(m => m.author.id === userFilter.id && m.createdTimestamp >= cutoffTimestamp);
        if (inWindow.size > 0) {
          const result = await channel.bulkDelete([...inWindow.values()], true).catch(() => null);
          deletedTotal += result ? result.size : 0;
        }

        const oldestInBatch = fetched.last().createdTimestamp;
        if (oldestInBatch < cutoffTimestamp || fetched.size < 100) stop = true;
      }
    } catch {
      continue; // brak dostępu do kanału itp. - pomijamy i idziemy dalej
    }
  }

  return deletedTotal;
}
