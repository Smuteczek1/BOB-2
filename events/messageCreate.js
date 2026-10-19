const { grantTextXp } = require('../utils/leveling');
const { askBob } = require('../utils/bob');

const DISCORD_MESSAGE_LIMIT = 2000;
const SAFE_TRIM_LIMIT = 1900;

module.exports = {
  name: 'messageCreate',
  async execute(message) {
    // XP za czat leci zawsze
    await grantTextXp(message.client, message);

    if (message.author.bot || !message.guild) return;

    if (!message.mentions.has(message.client.user.id)) return;

    await handleBobMention(message);
  },
};

async function handleBobMention(message) {
  const mentionRegex = new RegExp(`<@!?${message.client.user.id}>`, 'g');
  const question = message.content.replace(mentionRegex, '').trim();

  if (!question) {
    await message
      .reply('No i o co pytasz? Napisz coś, bo stoję tu jak kołek przy barze... 🥃')
      .catch(() => null);
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    await message
      .reply('⚠️ Ktoś zapomniał wlać mi paliwa do baku (brak `GEMINI_API_KEY` w `.env`). Powiedz o tym administratorowi.')
      .catch(() => null);
    return;
  }

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';

  await message.channel.sendTyping().catch(() => null);

  try {
    const answer = await askBob(question, apiKey, model);

    if (!answer) {
      await message.reply('Coś mi zamarzło w głowie... albo to ta wódka. Spróbuj jeszcze raz.').catch(() => null);
      return;
    }

    const trimmed =
      answer.length > SAFE_TRIM_LIMIT ? `${answer.slice(0, SAFE_TRIM_LIMIT)}…` : answer;

    await message.reply(trimmed.slice(0, DISCORD_MESSAGE_LIMIT)).catch(() => null);
  } catch (err) {
    console.error('Błąd podczas odpytywania Gemini (Bob):', err);
    await message
      .reply('❌ Coś poszło nie tak przy odpytywania Gemini. Spróbuj ponownie za chwilę.')
      .catch(() => null);
  }
}
