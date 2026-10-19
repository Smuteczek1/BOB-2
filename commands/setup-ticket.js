const { SlashCommandBuilder, ChannelType, PermissionFlagsBits, MessageFlags } = require('discord.js');
const db = require('../db');
const { buildPanelContainer, parseColorToInt, V2_FLAGS } = require('../utils/tickets');

const HEX_COLOR_REGEX = /^#?[0-9A-Fa-f]{6}$/;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup-ticket')
    .setDescription('Konfiguracja systemu ticketów')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommandGroup(group =>
      group
        .setName('kategoria')
        .setDescription('Kategoria Discord, w której tworzone są kanały ticketów')
        .addSubcommand(sub =>
          sub
            .setName('ustaw')
            .setDescription('Ustaw kategorię ticketów')
            .addChannelOption(opt =>
              opt
                .setName('kategoria')
                .setDescription('Kategoria (folder kanałów), w której mają się tworzyć tickety')
                .addChannelTypes(ChannelType.GuildCategory)
                .setRequired(true),
            ),
        ),
    )
    .addSubcommandGroup(group =>
      group
        .setName('rola-supportu')
        .setDescription('Rola widząca wszystkie tickety')
        .addSubcommand(sub =>
          sub
            .setName('ustaw')
            .setDescription('Ustaw rolę zespołu wsparcia')
            .addRoleOption(opt => opt.setName('rola').setDescription('Rola supportu').setRequired(true)),
        ),
    )
    .addSubcommandGroup(group =>
      group
        .setName('limit')
        .setDescription('Ile ticketów naraz może mieć otwartych jedna osoba')
        .addSubcommand(sub =>
          sub
            .setName('ustaw')
            .setDescription('Ustaw limit ticketów na osobę')
            .addIntegerOption(opt =>
              opt.setName('liczba').setDescription('Maks. liczba otwartych ticketów na osobę').setMinValue(1).setMaxValue(10).setRequired(true),
            ),
        ),
    )
    .addSubcommandGroup(group =>
      group
        .setName('typ')
        .setDescription('Zarządzanie kategoriami (typami) ticketów')
        .addSubcommand(sub =>
          sub
            .setName('dodaj')
            .setDescription('Dodaj nową kategorię ticketu')
            .addStringOption(opt => opt.setName('nazwa').setDescription('Nazwa kategorii, np. Pomoc').setRequired(true).setMaxLength(80))
            .addStringOption(opt =>
              opt.setName('kolor').setDescription('Kolor HEX, np. #5865F2').setRequired(true),
            )
            .addStringOption(opt => opt.setName('opis').setDescription('Krótki opis widoczny w menu i w ticketcie').setMaxLength(200))
            .addStringOption(opt => opt.setName('emoji').setDescription('Emoji (np. 🛠️ albo <:nazwa:id>)')),
        )
        .addSubcommand(sub =>
          sub
            .setName('usun')
            .setDescription('Usuń kategorię ticketu')
            .addStringOption(opt => opt.setName('nazwa').setDescription('Nazwa kategorii do usunięcia').setRequired(true)),
        )
        .addSubcommand(sub => sub.setName('lista').setDescription('Pokaż wszystkie kategorie ticketów')),
    )
    .addSubcommandGroup(group =>
      group
        .setName('panel')
        .setDescription('Publiczny panel z wyborem kategorii ticketu')
        .addSubcommand(sub =>
          sub
            .setName('publikuj')
            .setDescription('Opublikuj (lub odśwież) panel ticketów na kanale')
            .addChannelOption(opt =>
              opt.setName('kanal').setDescription('Kanał, na którym ma pojawić się panel').addChannelTypes(ChannelType.GuildText).setRequired(true),
            )
            .addStringOption(opt => opt.setName('tytul').setDescription('Tytuł panelu'))
            .addStringOption(opt => opt.setName('tekst').setDescription('Opis panelu')),
        ),
    ),

  async execute(interaction) {
    const group = interaction.options.getSubcommandGroup();
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    // --- /setup-ticket kategoria ustaw ---
    if (group === 'kategoria' && sub === 'ustaw') {
      const category = interaction.options.getChannel('kategoria');
      await db.setTicketConfig(guildId, { categoryId: category.id });
      await interaction.reply({ content: `✅ Kategoria ticketów ustawiona na **${category.name}**.`, flags: MessageFlags.Ephemeral });
      return;
    }

    // --- /setup-ticket rola-supportu ustaw ---
    if (group === 'rola-supportu' && sub === 'ustaw') {
      const role = interaction.options.getRole('rola');
      await db.setTicketConfig(guildId, { supportRoleId: role.id });
      await interaction.reply({ content: `✅ Rola supportu ustawiona na ${role}.`, flags: MessageFlags.Ephemeral });
      return;
    }

    // --- /setup-ticket limit ustaw ---
    if (group === 'limit' && sub === 'ustaw') {
      const liczba = interaction.options.getInteger('liczba');
      await db.setTicketConfig(guildId, { limitPerUser: liczba });
      await interaction.reply({ content: `✅ Limit otwartych ticketów na osobę ustawiony na **${liczba}**.`, flags: MessageFlags.Ephemeral });
      return;
    }

    // --- /setup-ticket typ dodaj ---
    if (group === 'typ' && sub === 'dodaj') {
      const nazwa = interaction.options.getString('nazwa');
      const kolorRaw = interaction.options.getString('kolor');
      const opis = interaction.options.getString('opis');
      const emoji = interaction.options.getString('emoji');

      if (!HEX_COLOR_REGEX.test(kolorRaw)) {
        await interaction.reply({
          content: '⚠️ Nieprawidłowy kolor. Podaj kod HEX, np. `#5865F2` albo `5865F2`.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const existing = await db.getTicketTypeByName(guildId, nazwa);
      if (existing) {
        await interaction.reply({ content: `⚠️ Kategoria o nazwie **${nazwa}** już istnieje.`, flags: MessageFlags.Ephemeral });
        return;
      }

      const color = kolorRaw.startsWith('#') ? kolorRaw : `#${kolorRaw}`;
      const type = await db.addTicketType(guildId, { name: nazwa, color, emoji, description: opis });

      await interaction.reply({
        content: `✅ Dodano kategorię **${type.name}** (kolor: ${color}). Nie zapomnij odświeżyć panelu (\`/setup-ticket panel publikuj\`).`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // --- /setup-ticket typ usun ---
    if (group === 'typ' && sub === 'usun') {
      const nazwa = interaction.options.getString('nazwa');
      const type = await db.getTicketTypeByName(guildId, nazwa);

      if (!type) {
        await interaction.reply({ content: `⚠️ Nie znaleziono kategorii o nazwie **${nazwa}**.`, flags: MessageFlags.Ephemeral });
        return;
      }

      await db.deleteTicketType(type.id);
      await interaction.reply({
        content: `🗑️ Usunięto kategorię **${type.name}**. Nie zapomnij odświeżyć panelu (\`/setup-ticket panel publikuj\`).`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // --- /setup-ticket typ lista ---
    if (group === 'typ' && sub === 'lista') {
      const types = await db.getTicketTypes(guildId);
      if (types.length === 0) {
        await interaction.reply({ content: 'ℹ️ Nie dodano jeszcze żadnej kategorii ticketów.', flags: MessageFlags.Ephemeral });
        return;
      }

      const lines = types.map(t => `• **${t.name}** — ${t.color}${t.emoji ? ` — ${t.emoji}` : ''}${t.description ? `\n  ↳ ${t.description}` : ''}`);
      await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
      return;
    }

    // --- /setup-ticket panel publikuj ---
    if (group === 'panel' && sub === 'publikuj') {
      const channel = interaction.options.getChannel('kanal');
      const tytul = interaction.options.getString('tytul');
      const tekst = interaction.options.getString('tekst');

      await db.setTicketPanelConfig(guildId, {
        channelId: channel.id,
        title: tytul ?? undefined,
        text: tekst ?? undefined,
      });

      const config = await db.getGuildConfig(guildId);
      const types = await db.getTicketTypes(guildId);
      const container = buildPanelContainer(config, types);

      // Jeśli panel już wcześniej istniał na tym kanale, spróbuj go podmienić zamiast duplikować.
      let message = null;
      if (config.ticket_panel_message_id) {
        message = await channel.messages.fetch(config.ticket_panel_message_id).catch(() => null);
      }

      if (message) {
        await message.edit({ components: [container], flags: V2_FLAGS });
      } else {
        message = await channel.send({ components: [container], flags: V2_FLAGS });
      }

      await db.setTicketPanelConfig(guildId, { channelId: channel.id, messageId: message.id });

      await interaction.reply({ content: `✅ Panel ticketów opublikowany na ${channel}.`, flags: MessageFlags.Ephemeral });
      return;
    }
  },
};
