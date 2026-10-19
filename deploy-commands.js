const fs = require('node:fs');
const path = require('node:path');
const { REST, Routes } = require('discord.js');

const commands = [];
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  commands.push(command.data.toJSON());
}

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log(`Rejestruję ${commands.length} komend(y)...`);

    if (process.env.GUILD_ID_DEV) {
      // Rejestracja na jednym serwerze - pojawia się natychmiast, dobre do testów
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID_DEV),
        { body: commands },
      );
      console.log(`✅ Zarejestrowano komendy na serwerze testowym (${process.env.GUILD_ID_DEV}).`);
    } else {
      // Rejestracja globalna - działa na wszystkich serwerach, ale propagacja może zająć do ~1h
      await rest.put(
        Routes.applicationCommands(process.env.CLIENT_ID),
        { body: commands },
      );
      console.log('✅ Zarejestrowano komendy globalnie (może potrwać do godziny, zanim się pojawią).');
    }
  } catch (err) {
    console.error('❌ Błąd podczas rejestracji komend:', err);
  }
})();
