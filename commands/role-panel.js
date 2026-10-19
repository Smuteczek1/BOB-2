const { SlashCommandBuilder, ChannelType, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');
const db = require('../db');
const {
  parseEmojiInput,
  buildPanelEmbed,
  buildPanelComponents,
  refreshPanelMessage,
} = require('../utils/rolePanels');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rola-panel')
    .setDescription('Zarządzanie panelami do samodzielnego wybierania ról (reakcje lub przyciski).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand(sub =>
      sub.setName('utworz')
        .setDescription('Tworzy nowy panel ról w wybranym kanale.')
        .addChannelOption(opt =>
          opt.setName('kanal')
            .setDescription('Kanał, na którym ma pojawić się panel')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true))
        .addStringOption(opt =>
          opt.setName('tryb')
            .setDescription('Czy role przyznawane są reakcją (emotką) czy przyciskiem?')
            .setRequired(true)
            .addChoices(
              { name: 'Emotki (reakcje)', value: 'emoji' },
              { name: 'Przyciski (buttony)', value: 'button' },
            ))
        .addStringOption(opt =>
          opt.setName('tytul')
            .setDescription('Tytuł panelu (opcjonalnie)')
            .setRequired(false))
        .addStringOption(opt =>
          opt.setName('opis')
            .setDescription('Krótki opis pod tytułem (opcjonalnie)')
            .setRequired(false)))
    .addSubcommand(sub =>
      sub.setName('dodaj')
        .setDescription('Dodaje rolę do istniejącego panelu.')
        .addIntegerOption(opt =>
          opt.setName('panel')
            .setDescription('ID panelu (zobacz /rola-panel lista)')
            .setRequired(true))
        .addRoleOption(opt =>
          opt.setName('rola')
            .setDescription('Rola do przyznawania')
            .setRequired(true))
        .addStringOption(opt =>
          opt.setName('emoji')
            .setDescription('Emoji (np. 🎮 albo custom <:nazwa:id>)')
            .setRequired(true))
        .addStringOption(opt =>
          opt.setName('etykieta')
            .setDescription('Tekst na przycisku (tylko tryb "przyciski", domyślnie nazwa roli)')
            .setRequired(false)))
    .addSubcommand(sub =>
      sub.setName('usun')
        .setDescription('Usuwa rolę z panelu (sam panel zostaje).')
        .addIntegerOption(opt =>
          opt.setName('panel')
            .setDescription('ID panelu')
            .setRequired(true))
        .addRoleOption(opt =>
          opt.setName('rola')
            .setDescription('Rola do usunięcia z panelu')
            .setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('usun-panel')
        .setDescription('Usuwa cały panel razem z wiadomością.')
        .addIntegerOption(opt =>
          opt.setName('panel')
            .setDescription('ID panelu')
            .setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('lista')
        .setDescription('Pokazuje wszystkie panele ról na tym serwerze.')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'utworz') return handleCreate(interaction);
    if (sub === 'dodaj') return handleAdd(interaction);
    if (sub === 'usun') return handleRemove(interaction);
    if (sub === 'usun-panel') return handleDeletePanel(interaction);
    if (sub === 'lista') return handleList(interaction);
  },
};

async function handleCreate(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const channel = interaction.options.getChannel('kanal');
  const mode = interaction.options.getString('tryb');
  const title = interaction.options.getString('tytul');
  const description = interaction.options.getString('opis');

  const panel = await db.createRolePanel(interaction.guild.id, {
    channelId: channel.id,
    mode,
    title,
    description,
  });

  if (!panel) {
    await interaction.editReply({ content: '❌ Nie udało się utworzyć panelu w bazie danych.' });
    return;
  }

  const embed = buildPanelEmbed(panel, [], interaction.guild);
  const components = buildPanelComponents(panel, []);

  const message = await channel.send({ embeds: [embed], components }).catch(() => null);
  if (!message) {
    await db.deleteRolePanel(panel.id);
    await interaction.editReply({ content: '❌ Nie udało się wysłać wiadomości panelu. Sprawdź uprawnienia bota na kanale.' });
    return;
  }

  await db.setRolePanelMessageId(panel.id, message.id);

  await interaction.editReply({
    content:
      `✅ Utworzono panel **#${panel.id}** (tryb: ${mode === 'emoji' ? 'emotki' : 'przyciski'}) na <#${channel.id}>.\n` +
      `Teraz dodaj role poleceniem, np.:\n` +
      `\`/rola-panel dodaj panel:${panel.id} rola:@NazwaRoli emoji:🎮${mode === 'button' ? ' etykieta:Gracz' : ''}\``,
  });
}

async function handleAdd(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const panelId = interaction.options.getInteger('panel');
  const role = interaction.options.getRole('rola');
  const emojiRawInput = interaction.options.getString('emoji');
  const etykieta = interaction.options.getString('etykieta');

  const panel = await db.getRolePanel(panelId);
  if (!panel || panel.guild_id !== interaction.guild.id) {
    await interaction.editReply({ content: `⚠️ Nie znaleziono panelu #${panelId} na tym serwerze.` });
    return;
  }

  const botMember = interaction.guild.members.me;
  if (role.position >= botMember.roles.highest.position) {
    await interaction.editReply({
      content:
        `⚠️ Rola **${role.name}** jest wyżej (lub tak samo wysoko) niż najwyższa rola bota, więc bot nie będzie ` +
        `mógł jej nadawać. Przesuń rolę bota wyżej w ustawieniach serwera (Ustawienia serwera -> Role) i spróbuj ponownie.`,
    });
    return;
  }

  const parsedEmoji = parseEmojiInput(emojiRawInput);
  const customId = panel.mode === 'button' ? `role_btn_${panel.id}_${role.id}` : null;
  const label = etykieta ?? role.name;

  await db.addRolePanelItem(panel.id, {
    roleId: role.id,
    emojiKey: parsedEmoji.key,
    emojiRaw: parsedEmoji.raw,
    label,
    customId,
  });

  const success = await refreshPanelMessage(interaction.client, panel.id);

  if (!success) {
    await interaction.editReply({ 
      content: `⚠️ Dodano rolę **${role.name}** do bazy danych, ale nie udało się odświeżyć wiadomości panelu na kanale. Upewnij się, że oryginalna wiadomość z panelem nie została usunięta.` 
    });
    return;
  }

  await interaction.editReply({ content: `✅ Dodano rolę **${role.name}** do panelu #${panel.id} i zaktualizowano panel na kanale!` });
}

async function handleRemove(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const panelId = interaction.options.getInteger('panel');
  const role = interaction.options.getRole('rola');

  const panel = await db.getRolePanel(panelId);
  if (!panel || panel.guild_id !== interaction.guild.id) {
    await interaction.editReply({ content: `⚠️ Nie znaleziono panelu #${panelId} na tym serwerze.` });
    return;
  }

  await db.removeRolePanelItemByRole(panel.id, role.id);
  await refreshPanelMessage(interaction.client, panel.id);

  await interaction.editReply({ content: `✅ Usunięto rolę **${role.name}** z panelu #${panel.id}.` });
}

async function handleDeletePanel(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const panelId = interaction.options.getInteger('panel');
  const panel = await db.getRolePanel(panelId);
  if (!panel || panel.guild_id !== interaction.guild.id) {
    await interaction.editReply({ content: `⚠️ Nie znaleziono panelu #${panelId} na tym serwerze.` });
    return;
  }

  if (panel.message_id) {
    const channel = await interaction.guild.channels.fetch(panel.channel_id).catch(() => null);
    const message = channel ? await channel.messages.fetch(panel.message_id).catch(() => null) : null;
    if (message) await message.delete().catch(() => null);
  }

  await db.deleteRolePanel(panel.id);

  await interaction.editReply({ content: `🗑️ Usunięto panel #${panelId} razem z wiadomością.` });
}

async function handleList(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let rawPanels = await db.listRolePanels?.(interaction.guild.id) || await db.getRolePanels?.(interaction.guild.id);

  let panels = [];
  if (Array.isArray(rawPanels)) {
    panels = rawPanels;
  } else if (rawPanels && Array.isArray(rawPanels.data)) {
    panels = rawPanels.data;
  }

  if (panels.length === 0) {
    await interaction.editReply({ content: '📋 Brak paneli ról na tym serwerze. Użyj `/rola-panel utworz`.' });
    return;
  }

  const lines = await Promise.all(
    panels.map(async panel => {
      let items = await db.getRolePanelItems(panel.id);
      if (items && Array.isArray(items.data)) items = items.data;
      const itemCount = Array.isArray(items) ? items.length : 0;

      const modeLabel = panel.mode === 'emoji' ? 'emotki' : 'przyciski';
      return `• **ID:** \`${panel.id}\` — <#${panel.channel_id}> — tryb: **${modeLabel}** — ról: **${itemCount}**`;
    })
  );

  const embed = new EmbedBuilder()
    .setTitle('⚙️ Lista paneli ról')
    .setColor(0x3498db)
    .setDescription(lines.join('\n'))
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
