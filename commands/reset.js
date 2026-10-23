const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder,
  MessageFlags,
} = require('discord.js');
const db = require('../db');
const { syncLevelRole } = require('../utils/levelRoles');

// Etykiety celów resetu (klucze muszą się zgadzać z RESET_TARGETS w db.js).
// Gdy dojdzie ekwipunek ze sklepu: dopisz tu np. inventory: 'Ekwipunek' i wpis w RESET_TARGETS.
const TARGET_LABELS = {
  coins: 'Monety',
  xp: 'EXP i poziomy',
  inventory: 'Ekwipunek (przedmioty, skrzynie, aktywne efekty)',
};

const CONFIRM_WORD = 'RESET';
const CONFIRM_TIME_MS = 60_000;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Zeruje monety i/lub EXP: dla jednej osoby albo dla całego serwera. Tylko administracja.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((opt) =>
      opt.setName('co')
        .setDescription('Co zresetować')
        .setRequired(true)
        .addChoices(
          { name: 'Monety', value: 'coins' },
          { name: 'EXP i poziomy', value: 'xp' },
          { name: 'Ekwipunek (przedmioty i skrzynie)', value: 'inventory' },
          { name: 'Wszystko (monety + EXP + ekwipunek)', value: 'all' },
        ))
    .addUserOption((opt) =>
      opt.setName('osoba').setDescription('Kogo zresetować. Zostaw puste, żeby zresetować CAŁY serwer.')),

  async execute(interaction) {
    // Drugie zabezpieczenie: administrator serwera może zmienić uprawnienia komend w ustawieniach integracji
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '⛔ Ta komenda jest tylko dla administracji.', flags: MessageFlags.Ephemeral });
      return;
    }

    const guild = interaction.guild;
    const what = interaction.options.getString('co');
    const target = interaction.options.getUser('osoba');
    const isGlobal = !target;

    if (target?.bot) {
      await interaction.reply({ content: 'Boty nie mają monet ani EXP-a. 🤖', flags: MessageFlags.Ephemeral });
      return;
    }

    const keys = what === 'all' ? db.RESET_TARGET_KEYS : [what];
    const userId = isGlobal ? null : target.id;

    // --- Podgląd: ile danych zostanie dotkniętych ---
    const preview = await db.previewReset(guild.id, userId, keys);
    const lines = keys.map((k) => {
      const p = preview[k];
      const unit = k === 'coins' ? 'monet' : k === 'xp' ? 'XP' : 'szt.';
      return `• **${TARGET_LABELS[k] ?? k}**: ${p.people} os., łącznie ${p.total.toLocaleString('pl-PL')} ${unit}`;
    });

    if (keys.every((k) => preview[k].people === 0)) {
      await interaction.reply({ content: 'ℹ️ Nie ma nic do zresetowania (wszystko już jest wyzerowane).', flags: MessageFlags.Ephemeral });
      return;
    }

    const scope = isGlobal ? '🌍 **CAŁY SERWER**' : `👤 ${target}`;
    const confirmEmbed = new EmbedBuilder()
      .setTitle(isGlobal ? '🚨 Reset CAŁEGO serwera' : '⚠️ Potwierdź reset')
      .setColor(isGlobal ? 0xe74c3c : 0xe67e22)
      .setDescription(
        `Zakres: ${scope}\n\n${lines.join('\n')}\n\n` +
        'Tego **nie da się cofnąć** z poziomu bota. Po resecie dostaniesz plik z kopią tego, co zostało usunięte.\n' +
        (isGlobal ? `Przy resecie całego serwera trzeba będzie dodatkowo wpisać słowo **${CONFIRM_WORD}**.\n` : '') +
        'Na decyzję masz 60 sekund.',
      );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('reset_ok').setLabel('Zatwierdź').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('reset_cancel').setLabel('Anuluj').setStyle(ButtonStyle.Secondary),
    );

    await interaction.reply({ embeds: [confirmEmbed], components: [row], flags: MessageFlags.Ephemeral });
    const message = await interaction.fetchReply();

    let click;
    try {
      click = await message.awaitMessageComponent({ filter: (i) => i.user.id === interaction.user.id, time: CONFIRM_TIME_MS });
    } catch {
      await interaction.editReply({ content: '⌛ Czas minął, nic nie zostało zmienione.', embeds: [], components: [] });
      return;
    }

    if (click.customId === 'reset_cancel') {
      await click.update({ content: '❎ Anulowano. Nic nie zostało zmienione.', embeds: [], components: [] });
      return;
    }

    // --- Reset całego serwera: dodatkowe potwierdzenie wpisaniem słowa ---
    let finisher = click; // interakcja, na której odpowiemy "Resetuję..."
    if (isGlobal) {
      const modal = new ModalBuilder()
        .setCustomId('reset_confirm_modal')
        .setTitle('Potwierdź reset całego serwera')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('confirm_word')
              .setLabel(`Wpisz ${CONFIRM_WORD}, aby potwierdzić`)
              .setStyle(TextInputStyle.Short)
              .setRequired(true),
          ),
        );
      await click.showModal(modal);

      let submit;
      try {
        submit = await click.awaitModalSubmit({
          filter: (i) => i.customId === 'reset_confirm_modal' && i.user.id === interaction.user.id,
          time: CONFIRM_TIME_MS,
        });
      } catch {
        await interaction.editReply({ content: '⌛ Czas minął, nic nie zostało zmienione.', embeds: [], components: [] });
        return;
      }

      const typed = submit.fields.getTextInputValue('confirm_word').trim().toUpperCase();
      if (typed !== CONFIRM_WORD) {
        await submit.update({ content: `❎ Wpisano nieprawidłowe słowo (trzeba **${CONFIRM_WORD}**). Nic nie zostało zmienione.`, embeds: [], components: [] });
        return;
      }
      finisher = submit;
    }

    await finisher.update({ content: '⏳ Resetuję...', embeds: [], components: [] });

    console.log(`[reset] ${interaction.user.tag} (${interaction.user.id}) resetuje [${keys.join(', ')}] dla ${isGlobal ? 'CAŁEGO serwera' : userId} na ${guild.id}`);

    let result;
    try {
      result = await db.resetData(guild.id, userId, keys);
    } catch (err) {
      console.error('[reset] błąd bazy:', err);
      await interaction.editReply({ content: '❌ Błąd bazy danych. Transakcja została cofnięta, **nic nie zostało zmienione**.' });
      return;
    }

    // Po resecie EXP-a role za poziom wracają do najniższej (poziom 0)
    let rolesSynced = 0;
    let roleErrors = 0;
    if (keys.includes('xp')) {
      for (const id of result.xp.userIds) {
        try {
          await syncLevelRole(interaction.client, guild.id, id, 0);
          rolesSynced++;
        } catch (err) {
          roleErrors++;
          console.error(`[reset] błąd ról dla ${id}:`, err);
        }
      }
    }

    // Kopia tego, co zostało usunięte (CSV)
    const csvLines = ['typ,user_id,wartosc_1,wartosc_2,opis'];
    for (const k of keys) {
      for (const b of result[k].backup) {
        const desc = b.type === 'monety' ? 'saldo / zarobione lacznie' : b.type === 'ekwipunek' ? 'ilosc / przedmiot' : 'xp / poziom';
        csvLines.push([b.type, `"${b.userId}"`, b.a, b.b, desc].join(','));
      }
    }
    const backup = new AttachmentBuilder(Buffer.from('\uFEFF' + csvLines.join('\n') + '\n', 'utf-8'), {
      name: `reset-kopia-${new Date().toISOString().slice(0, 10)}.csv`,
    });

    const summary = keys.map((k) => `• ${TARGET_LABELS[k] ?? k}: **${result[k].userIds.length}** os.`).join('\n');
    await interaction.editReply({
      content:
        `✅ **Reset wykonany** (${isGlobal ? 'cały serwer' : `<@${userId}>`}).\n${summary}\n` +
        (keys.includes('xp') ? `• Role za poziom zsynchronizowane: **${rolesSynced}**${roleErrors ? ` (błędy: ${roleErrors}, sprawdź hierarchię ról bota)` : ''}\n` : '') +
        '📎 W załączniku kopia usuniętych danych. Zachowaj ją, gdybyś chciał(a) coś przywrócić.',
      files: [backup],
    });
  },
};
