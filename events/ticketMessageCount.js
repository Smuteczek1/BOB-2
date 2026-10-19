const { handleTicketMessageForReminder } = require('../utils/tickets');

module.exports = {
  name: 'messageCreate',
  async execute(message) {
    await handleTicketMessageForReminder(message).catch(err =>
      console.error('Błąd w evencie liczenia wiadomości ticketu:', err),
    );
  },
};
