const { SlashCommandBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const db = require('../db');

// Kanał wyników kasyna: po każdej grze (automat, ruletka, moneta, blackjack) wiadomość z gry znika
// z kanału, na którym grano, a wynik ląduje tutaj. Bot rozpoznaje kanał po ID (zapisanym w bazie),
// więc można go swobodnie przemianować i przenieść.
module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup-kasyno')
    .setDescription('Ustawia kanał wyników kasyna: po grze wiadomość znika, a wynik trafia na ten kanał.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(opt =>
      opt.setName('kanal')
        .setDescription('Istniejący kanał tekstowy na wyniki (jeśli pominiesz, bot utworzy nowy).')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(false))
    .addChannelOption(opt =>
      opt.setName('kategoria')
        .setDescription('Kategoria dla nowego kanału (opcjonalnie).')
        .addChannelTypes(ChannelType.GuildCategory)
        .setRequired(false))
    .addStringOption(opt =>
      opt.setName('nazwa_kanalu')
        .setDescription('Nazwa nowego kanału (domyślnie: 🎰-wyniki-kasyna)')
        .setRequired(false))
    .addBooleanOption(opt =>
      opt.setName('wylacz')
        .setDescription('Wyłącza kanał wyników: wyniki znów zostają na kanale, na którym grano.')
        .setRequired(false)),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const guild = interaction.guild;

    try {
      if (interaction.options.getBoolean('wylacz')) {
        await db.setCasinoLogChannel(guild.id, null);
        await interaction.editReply({
          content: '✅ Kanał wyników kasyna wyłączony. Wyniki gier zostają na kanale, na którym ktoś gra.',
        });
        return;
      }

      let channel = interaction.options.getChannel('kanal');
      let created = false;

      if (channel) {
        // Istniejący kanał: sprawdzamy, czy bot będzie w stanie tam pisać
        const perms = channel.permissionsFor(guild.members.me);
        const missing = [
          [PermissionFlagsBits.ViewChannel, 'Wyświetlanie kanału'],
          [PermissionFlagsBits.SendMessages, 'Wysyłanie wiadomości'],
          [PermissionFlagsBits.EmbedLinks, 'Osadzanie linków'],
        ].filter(([flag]) => !perms?.has(flag)).map(([, name]) => name);
        if (missing.length > 0) {
          await interaction.editReply({
            content: `❌ Bot nie ma na <#${channel.id}> uprawnień: **${missing.join(', ')}**. Nadaj je i spróbuj ponownie.`,
          });
          return;
        }
      } else {
        const category = interaction.options.getChannel('kategoria');
        const name = interaction.options.getString('nazwa_kanalu') ?? '🎰-wyniki-kasyna';
        channel = await guild.channels.create({
          name,
          type: ChannelType.GuildText,
          parent: category ?? null,
          topic: 'Wyniki gier w kasynie Boba. Wiadomości z gier znikają z kanałów, a wynik trafia tutaj.',
          // Wszyscy czytają, pisze tylko bot
          permissionOverwrites: [
            { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.SendMessages] },
            {
              id: guild.members.me.id,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks],
            },
          ],
          reason: `Kanał wyników kasyna skonfigurowany przez ${interaction.user.tag}`,
        });
        created = true;
      }

      await db.setCasinoLogChannel(guild.id, channel.id);

      await interaction.editReply({
        content:
          `✅ Gotowe! Kanał wyników kasyna: <#${channel.id}>${created ? ' (nowy)' : ''}\n` +
          `Po każdej grze wiadomość z gry zniknie z kanału, na którym ktoś grał, a wynik pojawi się tutaj ` +
          `(z oznaczeniem, skąd pochodzi, bez pingowania gracza). Gracz zobaczy skrót wyniku i link w swoim prywatnym menu.\n\n` +
          `Jeśli bot nie zdoła wysłać wyniku na ten kanał, wynik zostaje na kanale gry, więc nic nie ginie.\n` +
          `Możesz zmienić nazwę i kategorię kanału, bot rozpoznaje go po ID. Wyłączysz to przez \`/setup-kasyno wylacz:True\`.`,
      });
    } catch (err) {
      console.error(err);
      await interaction.editReply({
        content: '❌ Nie udało się ustawić kanału. Sprawdź, czy bot ma uprawnienie **Zarządzaj kanałami** (przy tworzeniu nowego).',
      });
    }
  },
};
