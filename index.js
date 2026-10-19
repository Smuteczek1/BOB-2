// Bezpieczne wczytywanie .env
try {
  process.loadEnvFile();
} catch (err) {
  // Ignoruj brak pliku .env w środowisku produkcyjnym
}

const express = require('express'); // <-- Wczytanie Express
const fs = require('node:fs');
const path = require('node:path');
const { Client, Collection, GatewayIntentBits, Partials, MessageFlags, REST, Routes } = require('discord.js');
const db = require('./db');
const {
  BUTTON_CUSTOM_ID_PREFIX,
  MODAL_CUSTOM_ID_PREFIX,
  STYLE_MODAL_CUSTOM_ID_PREFIX,
  buildModal,
  handleModalSubmit,
  handleStyleModalSubmit,
} = require('./utils/suggestions');
const { handleRoleButtonClick } = require('./utils/rolePanels');
const {
  RULE_PRIVATE_OPEN_ID,
  RULE_PRIVATE_EXPAND_PREFIX,
  RULE_ACCEPT_ID,
  handleOpenPrivateView,
  handlePrivateExpandClick,
  handleAcceptClick,
} = require('./utils/verification');
const {
  RULE_POINT_EDIT_SELECT_ID,
  RULE_POINT_DELETE_SELECT_ID,
  RULE_POINT_ADD_MODAL_ID,
  RULE_POINT_EDIT_MODAL_PREFIX,
  handleRulePointEditSelect,
  handleRulePointDeleteSelect,
  handleRulePointAddModalSubmit,
  handleRulePointEditModalSubmit,
} = require('./utils/rulePoints');
const { tickVoiceXp, COOLDOWN_MS } = require('./utils/leveling');
const { LEVEL_ROLE_SELECT_CUSTOM_ID, handleLevelRoleSelectMenu } = require('./utils/levelRoles');
const {
  TICKET_TYPE_SELECT_ID,
  TICKET_OPEN_MODAL_PREFIX,
  TICKET_CLOSE_BUTTON_ID,
  TICKET_CLOSE_CONFIRM_ID,
  TICKET_CLOSE_CANCEL_ID,
  handleTicketTypeSelect,
  handleTicketOpenModalSubmit,
  handleTicketCloseClick,
  handleTicketCloseCancel,
  handleTicketCloseConfirm,
} = require('./utils/tickets');
const {
  PANEL_HOME_ID,
  PANEL_CATEGORY_PREFIX,
  ONB_BACK_ID,
  ONB_WELCOME_OPEN_ID,
  ONB_WELCOME_CHANNEL_ID,
  ONB_WELCOME_TOGGLE_ID,
  ONB_WELCOME_EDIT_ID,
  ONB_WELCOME_EDIT_MODAL_ID,
  ONB_GOODBYE_OPEN_ID,
  ONB_GOODBYE_CHANNEL_ID,
  ONB_GOODBYE_TOGGLE_ID,
  ONB_GOODBYE_EDIT_ID,
  ONB_GOODBYE_EDIT_MODAL_ID,
  ONB_ROLE_OPEN_ID,
  ONB_ROLE_SELECT_ID,
  ONB_ROLE_TOGGLE_ID,
  handlePanelHomeClick,
  handleCategoryClick,
  handleOnboardingBack,
  handleWelcomeOpen,
  handleWelcomeChannelSelect,
  handleWelcomeToggle,
  handleWelcomeEditClick,
  handleWelcomeEditModalSubmit,
  handleGoodbyeOpen,
  handleGoodbyeChannelSelect,
  handleGoodbyeToggle,
  handleGoodbyeEditClick,
  handleGoodbyeEditModalSubmit,
  handleStarterRoleOpen,
  handleStarterRoleSelect,
  handleStarterRoleToggle,
} = require('./utils/panel');

// --- Uruchomienie prostego serwera HTTP dla Render.com ---
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('🤖 Bot działa poprawnie 24/7!');
});

app.listen(PORT, () => {
  console.log(`🌐 Serwer HTTP dla Render uruchomiony na porcie ${PORT}`);
});

// --- Konfiguracja Klienta Discord ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User, Partials.GuildMember],
});

client.commands = new Collection();

// --- Ładowanie komend ---
const commandsPath = path.join(__dirname, 'commands');
if (fs.existsSync(commandsPath)) {
  for (const file of fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'))) {
    const command = require(path.join(commandsPath, file));
    client.commands.set(command.data.name, command);
  }
}

// --- Ładowanie eventów z folderu /events ---
const eventsPath = path.join(__dirname, 'events');
if (fs.existsSync(eventsPath)) {
  for (const file of fs.readdirSync(eventsPath).filter(f => f.endsWith('.js'))) {
    const event = require(path.join(eventsPath, file));
    if (event.once) {
      client.once(event.name, (...args) => event.execute(...args));
    } else {
      client.on(event.name, (...args) => event.execute(...args));
    }
  }
}

// --- Obsługa interakcji ---
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) return;
      await command.execute(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith(BUTTON_CUSTOM_ID_PREFIX)) {
      const boardId = interaction.customId.slice(BUTTON_CUSTOM_ID_PREFIX.length);
      await interaction.showModal(buildModal(boardId));
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith(MODAL_CUSTOM_ID_PREFIX)) {
      await handleModalSubmit(interaction);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith(STYLE_MODAL_CUSTOM_ID_PREFIX)) {
      await handleStyleModalSubmit(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('role_btn_')) {
      await handleRoleButtonClick(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId === RULE_PRIVATE_OPEN_ID) {
      await handleOpenPrivateView(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith(RULE_PRIVATE_EXPAND_PREFIX)) {
      await handlePrivateExpandClick(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId === RULE_ACCEPT_ID) {
      await handleAcceptClick(interaction);
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === RULE_POINT_EDIT_SELECT_ID) {
      await handleRulePointEditSelect(interaction);
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === RULE_POINT_DELETE_SELECT_ID) {
      await handleRulePointDeleteSelect(interaction);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === RULE_POINT_ADD_MODAL_ID) {
      await handleRulePointAddModalSubmit(interaction);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith(RULE_POINT_EDIT_MODAL_PREFIX)) {
      await handleRulePointEditModalSubmit(interaction);
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === LEVEL_ROLE_SELECT_CUSTOM_ID) {
      await handleLevelRoleSelectMenu(interaction);
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === TICKET_TYPE_SELECT_ID) {
      await handleTicketTypeSelect(interaction);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith(TICKET_OPEN_MODAL_PREFIX)) {
      await handleTicketOpenModalSubmit(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId === TICKET_CLOSE_BUTTON_ID) {
      await handleTicketCloseClick(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId === TICKET_CLOSE_CONFIRM_ID) {
      await handleTicketCloseConfirm(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId === TICKET_CLOSE_CANCEL_ID) {
      await handleTicketCloseCancel(interaction);
      return;
    }

    // --- Panel konfiguracji (/panel) ---
    if (interaction.isButton() && interaction.customId === PANEL_HOME_ID) {
      await handlePanelHomeClick(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith(PANEL_CATEGORY_PREFIX)) {
      await handleCategoryClick(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId === ONB_BACK_ID) {
      await handleOnboardingBack(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId === ONB_WELCOME_OPEN_ID) {
      await handleWelcomeOpen(interaction);
      return;
    }

    if (interaction.isChannelSelectMenu() && interaction.customId === ONB_WELCOME_CHANNEL_ID) {
      await handleWelcomeChannelSelect(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId === ONB_WELCOME_TOGGLE_ID) {
      await handleWelcomeToggle(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId === ONB_WELCOME_EDIT_ID) {
      await handleWelcomeEditClick(interaction);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === ONB_WELCOME_EDIT_MODAL_ID) {
      await handleWelcomeEditModalSubmit(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId === ONB_GOODBYE_OPEN_ID) {
      await handleGoodbyeOpen(interaction);
      return;
    }

    if (interaction.isChannelSelectMenu() && interaction.customId === ONB_GOODBYE_CHANNEL_ID) {
      await handleGoodbyeChannelSelect(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId === ONB_GOODBYE_TOGGLE_ID) {
      await handleGoodbyeToggle(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId === ONB_GOODBYE_EDIT_ID) {
      await handleGoodbyeEditClick(interaction);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === ONB_GOODBYE_EDIT_MODAL_ID) {
      await handleGoodbyeEditModalSubmit(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId === ONB_ROLE_OPEN_ID) {
      await handleStarterRoleOpen(interaction);
      return;
    }

    if (interaction.isRoleSelectMenu() && interaction.customId === ONB_ROLE_SELECT_ID) {
      await handleStarterRoleSelect(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId === ONB_ROLE_TOGGLE_ID) {
      await handleStarterRoleToggle(interaction);
      return;
    }
  } catch (err) {
    console.error('Błąd podczas obsługi interakcji:', err);
    const payload = { content: '❌ Wystąpił błąd podczas wykonywania tej akcji.', flags: MessageFlags.Ephemeral };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch(() => null);
    } else {
      await interaction.reply(payload).catch(() => null);
    }
  }
});

// --- Start bota ---
client.once('ready', async () => {
  console.log(`✅ Zalogowano jako ${client.user.tag}`);

  // 1. Automatyczne odświeżenie i rejestracja komend Slash w API Discorda
  await registerSlashCommands();

  // 2. Porządkowanie kanałów tymczasowych
  await reconcileTempChannels();

  // 3. Jednorazowe wstawienie domyślnego rekordu sesji głosowej (jeśli tabela jest pusta)
  await seedInitialVoiceRecord();

  // 4. Pętla XP za głosowe
  const scheduleVoiceTick = () => {
    const randomMinutes = Math.floor(Math.random() * (10 - 5 + 1)) + 5; // 5 - 10 min
    setTimeout(async () => {
      await tickVoiceXp(client).catch(err => console.error('Błąd XP głosowego:', err));
      scheduleVoiceTick();
    }, randomMinutes * 60 * 1000);
  };
  scheduleVoiceTick();
});

// Funkcja rejestrująca komendy Slash w Discord API
async function registerSlashCommands() {
  try {
    const commandsData = Array.from(client.commands.values()).map(c => c.data.toJSON());
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

    console.log('🔄 Rejestrowanie/Aktualizowanie komend Slash...');
    
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commandsData }
    );

    console.log('✅ Wszystkie komendy Slash (w tym /nagroda) zostały zarejestrowane!');
  } catch (error) {
    console.error('❌ Błąd podczas rejestracji komend Slash:', error);
  }
}

// Funkcja dodająca jednorazowy rekord startowy do tabeli sesji głosowych
async function seedInitialVoiceRecord() {
  try {
    const check = await db.raw.query('SELECT COUNT(*)::int as count FROM sessions');
    if (check.rows[0].count === 0) {
      const now = Date.now();
      await db.raw.query(`
        INSERT INTO sessions (guild_id, channel_id, creator_id, started_at, ended_at, duration_seconds)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, ['0', '0', 'SYSTEM', now - 1000, now, 1]);
      console.log('📌 Dodano początkowy rekord do tabeli sesji głosowych.');
    }
  } catch (err) {
    console.error('❌ Nie udało się dodać rekordu do tabeli sesji:', err);
  }
}

async function reconcileTempChannels() {
  const tempChannels = await db.getAllTempChannels();
  if (!tempChannels) return;

  for (const temp of tempChannels) {
    try {
      const guild = await client.guilds.fetch(temp.guild_id).catch(() => null);
      if (!guild) {
        await db.removeTempChannel(temp.channel_id);
        continue;
      }
      
      const channel = await guild.channels.fetch(temp.channel_id, { force: true }).catch(() => null);
      if (!channel) {
        await db.removeTempChannel(temp.channel_id);
        continue;
      }

      if (channel.members.size === 0) {
        await channel.delete('Sprzątanie po restarcie bota - kanał był pusty').catch(() => null);
        await db.removeTempChannel(temp.channel_id);
      }
    } catch (err) {
      console.error('Błąd podczas porządkowania kanałów tymczasowych:', err);
    }
  }
}

client.login(process.env.DISCORD_TOKEN);
