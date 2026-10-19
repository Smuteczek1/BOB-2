const { handleReactionToggle } = require('../utils/rolePanels');

module.exports = {
  name: 'messageReactionAdd',
  async execute(reaction, user) {
    await handleReactionToggle(reaction, user, true);
  },
};
