const { sendGoodbyeMessage } = require('../utils/onboarding');

module.exports = {
  name: 'guildMemberRemove',
  async execute(member) {
    if (member.user?.bot) return;

    // Wiadomość pożegnalna (jeśli skonfigurowana w /setup-pozegnanie)
    await sendGoodbyeMessage(member);
  },
};
