const db = require('../db');
const { syncLevelRole } = require('../utils/levelRoles');
const { sendWelcomeMessage } = require('../utils/onboarding');

module.exports = {
  name: 'guildMemberAdd',
  async execute(member) {
    if (member.user.bot) return;

    // Jeśli ktoś wrócił na serwer i miał już zapisany postęp - dostaje rolę adekwatną
    // do swojego poprzedniego poziomu, a nie zawsze startową.
    const existing = await db.getUserLevel(member.guild.id, member.id); // <-- naprawiony brakujący await
    const level = existing ? existing.level : 0;

    await syncLevelRole(member.client, member.guild.id, member.id, level);

    // Nadanie roli startowej (jeśli skonfigurowana w /rola-startowa)
    try {
      const config = await db.getGuildConfig(member.guild.id);
      if (config && config.starter_role_id) {
        await member.roles.add(config.starter_role_id);
      }
    } catch (err) {
      console.error('Nie udało się nadać roli startowej (sprawdź hierarchię ról bota):', err);
    }

    // Wiadomość powitalna (jeśli skonfigurowana w /setup-powitanie)
    await sendWelcomeMessage(member);
  },
};
