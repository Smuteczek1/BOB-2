const { SlashCommandBuilder, ChannelType, PermissionFlagsBits, MessageFlags } = require('discord.js');
const db = require('../db');
const {
  buildIntroContainer,
  buildRegulaminContainer,
  V2_FLAGS,
} = require('../utils/verification');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup-regulamin')
    .setDescription('Konfiguruje regulamin serwera z akceptacją przez przycisk.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub
      .setName('ustaw')
      .setDescription('Ustawia kanał, rolę i treści regulaminu.')
      .addChannelOption(opt => opt
        .setName('kanal')
        .setDescription('Kanał, na którym ma pojawić się okno regulaminu')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true))
      .addRoleOption(opt => opt
        .setName('rola')
        .setDescription('Rola nadawana po zaakceptowaniu regulaminu (np. Zweryfikowany)')
        .setRequired(true))
      .addStringOption(opt => opt
        .setName('tytul')
        .setDescription('Własny tytuł okna publicznego (domyślnie "📜 Regulamin serwera"). Opcjonalne.')
        .setRequired(false))
      .addStringOption(opt => opt
        .setName('tekst')
        .setDescription('Własny opis okna publicznego (użyj \\n dla nowej linii). Opcjonalne.')
        .setRequired(false))
      .addStringOption(opt => opt
        .setName('przycisk')
        .setDescription('Etykieta przycisku otwierającego regulamin (domyślnie "Sprawdź regulamin"). Opcjonalne.')
        .setRequired(false))
      .addStringOption(opt => opt
        .setName('komentarz')
        .setDescription('Mały komentarz pod przyciskiem publicznym. Opcjonalne.')
        .setRequired(false))
      .addStringOption(opt => opt
        .setName('akceptuj_tytul')
        .setDescription('Tytuł sekcji akceptacji na dole widoku (domyślnie "Akceptacja regulaminu"). Opcjonalne.')
        .setRequired(false))
      .addStringOption(opt => opt
        .setName('akceptuj_tekst')
        .setDescription('Tekst sekcji akceptacji, nad przyciskiem (użyj \\n dla nowej linii). Opcjonalne.')
        .setRequired(false))
      .addStringOption(opt => opt
        .setName('akceptuj_przycisk')
        .setDescription('Etykieta przycisku akceptacji (domyślnie "Akceptuję regulamin"). Opcjonalne.')
        .setRequired(false))
      .addStringOption(opt => opt
        .setName('akceptuj_komentarz')
        .setDescription('Mały komentarz pod przyciskiem akceptacji. Opcjonalne.')
        .setRequired(false)))
    .addSubcommand(sub => sub
      .setName('publikuj')
      .setDescription('Publikuje/odświeża publiczne okno regulaminu na kanale.'))
    .addSubcommand(sub => sub
      .setName('podglad')
      .setDescription('Pokazuje lokalny podgląd całego regulaminu (widoczny tylko dla Ciebie).'))
    .addSubcommand(sub => sub
      .setName('usun')
      .setDescription('Usuwa opublikowane okno regulaminu z kanału (definicje punktów zostają zachowane).')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    if (sub === 'ustaw') {
      const channel = interaction.options.getChannel('kanal');
      const role = interaction.options.getRole('rola');

      const tytul = interaction.options.getString('tytul') ?? undefined;
      const przycisk = interaction.options.getString('przycisk') ?? undefined;
      const komentarz = interaction.options.getString('komentarz') ?? undefined;
      const akceptujTytul = interaction.options.getString('akceptuj_tytul') ?? undefined;
      const akceptujPrzycisk = interaction.options.getString('akceptuj_przycisk') ?? undefined;
      const akceptujKomentarz = interaction.options.getString('akceptuj_komentarz') ?? undefined;

      const unescape = (v) => (v ? v.replaceAll('\\n', '\n') : undefined);
      const tekst = unescape(interaction.options.getString('tekst'));
      const akceptujTekst = unescape(interaction.options.getString('akceptuj_tekst'));

      if (role.managed) {
        await interaction.reply({
          content: '❌ Nie można ustawić jako roli weryfikacyjnej roli zarządzanej przez integrację/bota.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const botMember = interaction.guild.members.me;
      if (botMember && role.position >= botMember.roles.highest.position) {
        await interaction.reply({
          content:
            '⚠️ Ta rola jest wyżej (lub na równi) w hierarchii niż najwyższa rola bota — ' +
            'bot **nie będzie w stanie** jej nadawać. Przesuń rolę bota wyżej na liście ról serwera.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await db.setVerificationConfig(guildId, {
        channelId: channel.id,
        roleId: role.id,
        rulesText: tekst,
        rulesTitle: tytul,
        buttonLabel: przycisk,
        introComment: komentarz,
        acceptTitle: akceptujTytul,
        acceptText: akceptujTekst,
        acceptButtonLabel: akceptujPrzycisk,
        acceptComment: akceptujKomentarz,
      });

      await interaction.reply({
        content:
          `✅ Skonfigurowano regulamin!\n` +
          `📍 Kanał: <#${channel.id}>\n` +
          `🎭 Rola po akceptacji: <@&${role.id}>\n\n` +
          `Teraz dodaj punkty regulaminu przez \`/regulamin-punkt dodaj\`, a na końcu użyj \`/setup-regulamin publikuj\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'publikuj') {
      const config = await db.getGuildConfig(guildId);
      if (!config || !config.verify_channel_id || !config.verify_role_id) {
        await interaction.reply({
          content: '⚠️ Najpierw skonfiguruj kanał i rolę przez `/setup-regulamin ustaw`.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const points = await db.getRulePoints(guildId);
      if (!points || points.length === 0) {
        await interaction.reply({
          content: '⚠️ Nie masz jeszcze żadnych punktów regulaminu — dodaj je przez `/regulamin-punkt dodaj`.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const channel = await interaction.guild.channels.fetch(config.verify_channel_id).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        await interaction.editReply({ content: '❌ Nie mogę znaleźć skonfigurowanego kanału — sprawdź `/setup-regulamin ustaw`.' });
        return;
      }

      // Usuwamy starą wiadomość (jeśli istniała).
      if (config.verify_intro_message_id) {
        const oldMsg = await channel.messages.fetch(config.verify_intro_message_id).catch(() => null);
        if (oldMsg) await oldMsg.delete().catch(() => null);
      }

      // Publikujemy JEDYNĄ publiczną wiadomość - resztę (punkty + akceptacja) użytkownik
      // widzi dopiero po kliknięciu przycisku, w swoim prywatnym widoku.
      const introContainer = buildIntroContainer(interaction.guild, config);
      const introMessage = await channel.send({ components: [introContainer], flags: V2_FLAGS });

      await db.setVerificationMessageIds(guildId, { introMessageId: introMessage.id });

      await interaction.editReply({
        content:
          `✅ Opublikowano okno regulaminu na <#${channel.id}>!\n` +
          `📄 Punktów: **${points.length}**\n` +
          `🎭 Rola po akceptacji: <@&${config.verify_role_id}>`,
      });
      return;
    }

    if (sub === 'podglad') {
      const config = await db.getGuildConfig(guildId);
      const points = await db.getRulePoints(guildId);

      const introContainer = buildIntroContainer(interaction.guild, config);
      const fullContainer = buildRegulaminContainer(interaction.guild, points, config, new Set(), false);

      await interaction.reply({
        components: [introContainer, fullContainer],
        flags: MessageFlags.Ephemeral | V2_FLAGS,
      });
      return;
    }

    if (sub === 'usun') {
      const config = await db.getGuildConfig(guildId);

      if (config?.verify_channel_id && config.verify_intro_message_id) {
        const channel = await interaction.guild.channels.fetch(config.verify_channel_id).catch(() => null);
        if (channel) {
          const msg = await channel.messages.fetch(config.verify_intro_message_id).catch(() => null);
          if (msg) await msg.delete().catch(() => null);
        }
      }

      await db.setVerificationMessageIds(guildId, { introMessageId: null });

      await interaction.reply({
        content:
          '✅ Usunięto opublikowane okno regulaminu z kanału.\n' +
          'ℹ️ Definicje punktów zostały zachowane — możesz opublikować ponownie przez `/setup-regulamin publikuj`.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
