const { SlashCommandBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const { createSuggestionBoard, buildStyleModal, storePendingSetup } = require('../utils/suggestions');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup-propozycje')
    .setDescription('Tworzy NOWĄ tablicę propozycji (możesz odpalić tę komendę wiele razy, żeby mieć kilka niezależnych).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(opt =>
      opt.setName('kategoria')
        .setDescription('Kategoria, w której mają powstać oba kanały (opcjonalnie). Można to zmienić później ręcznie.')
        .addChannelTypes(ChannelType.GuildCategory)
        .setRequired(false))
    .addStringOption(opt =>
      opt.setName('nazwa_listy')
        .setDescription('Nazwa kanału z listą propozycji (domyślnie: 📋-lista-propozycji)')
        .setRequired(false))
    .addStringOption(opt =>
      opt.setName('nazwa_tworzenia')
        .setDescription('Nazwa kanału z przyciskiem do tworzenia propozycji (domyślnie: 📝-utwórz-propozycję)')
        .setRequired(false))
    .addStringOption(opt =>
      opt.setName('styl')
        .setDescription('Domyślny tekst i przycisk, czy chcesz wpisać własne w osobnym oknie?')
        .setRequired(false)
        .addChoices(
          { name: 'Domyślny', value: 'domyslny' },
          { name: 'Własny (otworzy się okno do wpisania tekstu i przycisku)', value: 'wlasny' },
        ))
    .addStringOption(opt =>
      opt.setName('emotka_za')
        .setDescription('Emotka głosu "za" (domyślnie ✅) - zwykła albo custom z tego serwera, np. <:hype:123...>')
        .setRequired(false))
    .addStringOption(opt =>
      opt.setName('emotka_przeciw')
        .setDescription('Emotka głosu "przeciw" (domyślnie ❌) - zwykła albo custom z tego serwera')
        .setRequired(false)),

  async execute(interaction) {
    const category = interaction.options.getChannel('kategoria');
    const listName = interaction.options.getString('nazwa_listy') ?? '📋-lista-propozycji';
    const createName = interaction.options.getString('nazwa_tworzenia') ?? '📝-utwórz-propozycję';
    const styl = interaction.options.getString('styl') ?? 'domyslny';
    const upvoteEmoji = interaction.options.getString('emotka_za');
    const downvoteEmoji = interaction.options.getString('emotka_przeciw');

    const pendingData = {
      categoryId: category?.id ?? null,
      listName,
      createName,
      upvoteEmoji,
      downvoteEmoji,
    };

    if (styl === 'wlasny') {
      // WAŻNE: modal musi być PIERWSZĄ odpowiedzią na interakcję (nie można wcześniej
      // zrobić deferReply), dlatego od razu pokazujemy okno, a dane potrzebne do
      // stworzenia kanałów (kategoria, nazwy, emotki) zapisujemy tymczasowo pod tokenem
      // (tu: ID tej interakcji) - odbierze je handleStyleModalSubmit po wysłaniu formularza.
      const token = interaction.id;
      storePendingSetup(token, pendingData);
      await interaction.showModal(buildStyleModal(token));
      return;
    }

    await createSuggestionBoard(interaction, { ...pendingData, promptText: null, buttonLabel: null });
  },
};
