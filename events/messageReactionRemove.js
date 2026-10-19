const { handleReactionToggle } = require('../utils/rolePanels');

module.exports = {
  name: 'messageReactionRemove',
  async execute(reaction, user) {
    await handleReactionToggle(reaction, user, false);
  },
};
