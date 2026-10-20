const { startScheduler } = require('../utils/lotto');

// Uruchamia codzienne losowanie lotto po starcie bota (loader w index.js wczytuje pliki z /events automatycznie).
module.exports = {
  name: 'ready',
  once: true,
  execute(client) {
    startScheduler(client);
  },
};
