const {
  SlashCommandBuilder,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} = require('discord.js');
const crime = require('../utils/crime');
const H = require('../utils/heists');

// ============================================================
//  /banda: PRYWATNE menu bandy (grupy przestępczej), Components V2.
//  Bandę zakłada się nazwą, zaprasza się graczy (zaproszenie ważne 48 h), można być w maks. 2 bandach (maks. 8 osób w bandzie).
//  Duże skoki (`/napad`) robi się tylko z członkami JEDNEJ bandy. Logika i baza: utils/crime.js.
// ============================================================

const V2 = MessageFlags.IsComponentsV2;
const IDLE_MS = 5 * 60_000;
const MAX_MS = 14 * 60_000;
const text = (s) => new TextDisplayBuilder().setContent(s);
const sep = () => new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small);
const btn = (id, label, style = ButtonStyle.Secondary, { emoji, disabled = false } = {}) => {
  const b = new ButtonBuilder().setCustomId(id).setStyle(style).setDisabled(disabled);
  if (label) b.setLabel(label.slice(0, 80));
  if (emoji) b.setEmoji(emoji);
  return b;
};
const ts = (ms) => Math.floor(ms / 1000);

const ERRORS = {
  name: '⚠️ Nazwa bandy: 3-20 znaków (litery, cyfry, spacja, `_ - . \' !`).',
  taken: '⚠️ Taka nazwa jest już zajęta.',
  limit: `🚫 Możesz należeć najwyżej do ${H.MAX_GANGS_PER_USER} band.`,
  not_leader: '🚫 To może zrobić tylko lider bandy.',
  member: '⚠️ Ten gracz już jest w twojej bandzie.',
  full: `🚫 Banda ma już maksymalną liczbę członków (${H.MAX_GANG_MEMBERS}).`,
  target_limit: `🚫 Ten gracz jest już w ${H.MAX_GANGS_PER_USER} bandach.`,
  invited: '⚠️ Ten gracz ma już aktywne zaproszenie do tej bandy.',
  gone: '⌛ To zaproszenie nie jest już ważne.',
  self: '🚫 Siebie nie wyrzucisz. Użyj „Opuść bandę”.',
  not_member: '⚠️ Tej osoby nie ma w bandzie.',
};

function newSession(interaction) {
  return {
    interaction,
    guildId: interaction.guild.id,
    user: interaction.user,
    collector: null,
    state: { view: 'main', gangId: null, confirm: null, notice: null },
  };
}

async function buildPanel(session, { disabled = false } = {}) {
  const { state } = session;
  const [gangs, invites] = await Promise.all([crime.getMyGangs(session.guildId, session.user.id), crime.getInvites(session.guildId, session.user.id)]);
  const box = new ContainerBuilder().setAccentColor(0x8e44ad);
  if (state.notice) {
    box.addTextDisplayComponents(text(state.notice));
    box.addSeparatorComponents(sep());
  }

  if (state.view === 'invites') {
    box.addTextDisplayComponents(text('## ✉️ Zaproszenia do band\n-# Zaproszenie wygasa po 48 godzinach.'));
    box.addSeparatorComponents(sep());
    if (invites.length === 0) box.addTextDisplayComponents(text('_Nie masz zaproszeń._'));
    for (const inv of invites.slice(0, 5)) {
      box.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(text(`**${inv.name}**\n-# zaprasza <@${inv.invitedBy}> · wygasa <t:${ts(inv.expiresAt)}:R>`))
          .setButtonAccessory(btn(`bd_acc:${inv.gangId}`, 'Dołącz', ButtonStyle.Success, { emoji: '✅', disabled })),
      );
      box.addActionRowComponents(new ActionRowBuilder().addComponents(btn(`bd_dec:${inv.gangId}`, `Odrzuć: ${inv.name}`, ButtonStyle.Secondary, { emoji: '✖️', disabled })));
    }
    box.addActionRowComponents(new ActionRowBuilder().addComponents(btn('bd_back', 'Wróć', ButtonStyle.Secondary, { emoji: '◀️', disabled })));
    return { components: [box], flags: V2 };
  }

  const gang = gangs.find((g) => g.id === state.gangId) ?? gangs[0] ?? null;
  state.gangId = gang?.id ?? null;
  box.addTextDisplayComponents(text(`## 🕵️ Bandy\n-# Duże skoki robisz tylko z członkami jednej bandy (\`/napad\`). Możesz być w maks. ${H.MAX_GANGS_PER_USER} bandach.`));
  box.addSeparatorComponents(sep());

  if (!gang) {
    box.addTextDisplayComponents(text('_Nie należysz do żadnej bandy. Załóż własną albo przyjmij zaproszenie._'));
  } else {
    const isLeader = gang.leaderId === session.user.id;
    const members = gang.members.map((m) => `${m.userId === gang.leaderId ? '👑' : '▫️'} <@${m.userId}>`).join('\n');
    box.addTextDisplayComponents(text(`### ${gang.name}\n-# Lider: <@${gang.leaderId}> · członkowie: **${gang.members.length}/${H.MAX_GANG_MEMBERS}**\n${members}`));

    if (gangs.length > 1) {
      box.addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('bd_pick')
            .setPlaceholder('Wybierz bandę')
            .setDisabled(disabled)
            .addOptions(gangs.map((g) => ({ label: g.name.slice(0, 100), value: String(g.id), default: g.id === gang.id, description: g.leaderId === session.user.id ? 'Jesteś liderem' : 'Jesteś członkiem' }))),
        ),
      );
    }
    if (isLeader) {
      box.addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new UserSelectMenuBuilder().setCustomId('bd_invite').setPlaceholder('Zaproś gracza do bandy…').setMinValues(1).setMaxValues(1).setDisabled(disabled || gang.members.length >= H.MAX_GANG_MEMBERS),
        ),
      );
      const others = gang.members.filter((m) => m.userId !== session.user.id);
      if (others.length) {
        box.addActionRowComponents(
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId('bd_kick')
              .setPlaceholder('Wyrzuć członka…')
              .setDisabled(disabled)
              .addOptions(others.slice(0, 25).map((m) => ({ label: `Wyrzuć ${session.names?.[m.userId] ?? m.userId}`.slice(0, 100), value: m.userId }))),
          ),
        );
      }
    }
    if (state.confirm) {
      box.addTextDisplayComponents(text(state.confirm === 'disband' ? `⚠️ Na pewno **rozwiązać** bandę „${gang.name}”? Tego nie da się cofnąć.` : `⚠️ Na pewno **opuścić** bandę „${gang.name}”?${isLeader && gang.members.length > 1 ? ' Przywództwo przejmie najstarszy członek.' : ''}`));
      box.addActionRowComponents(
        new ActionRowBuilder().addComponents(
          btn(`bd_do_${state.confirm}`, 'Tak, potwierdzam', ButtonStyle.Danger, { emoji: '✅', disabled }),
          btn('bd_cancel', 'Anuluj', ButtonStyle.Secondary, { disabled }),
        ),
      );
    } else {
      box.addActionRowComponents(
        new ActionRowBuilder().addComponents(
          btn('bd_leave', 'Opuść bandę', ButtonStyle.Secondary, { emoji: '🚪', disabled }),
          ...(isLeader ? [btn('bd_disband', 'Rozwiąż bandę', ButtonStyle.Danger, { emoji: '💥', disabled })] : []),
        ),
      );
    }
  }
  box.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      btn('bd_new', 'Załóż bandę', ButtonStyle.Success, { emoji: '➕', disabled: disabled || gangs.length >= H.MAX_GANGS_PER_USER }),
      btn('bd_invites', `Zaproszenia (${invites.length})`, invites.length ? ButtonStyle.Primary : ButtonStyle.Secondary, { emoji: '✉️', disabled }),
      btn('bd_refresh', 'Odśwież', ButtonStyle.Secondary, { emoji: '🔄', disabled }),
      btn('bd_close', 'Zamknij', ButtonStyle.Danger, { emoji: '✖️', disabled }),
    ),
  );
  return { components: [box], flags: V2 };
}

const farewell = (msg) => ({ components: [new ContainerBuilder().setAccentColor(0x95a5a6).addTextDisplayComponents(text(msg))], flags: V2 });

async function render(session) {
  const payload = await buildPanel(session);
  try {
    await session.interaction.editReply(payload);
  } catch {
    await new Promise((r) => setTimeout(r, 700));
    await session.interaction.editReply(payload);
  }
}

async function onClick(click, session) {
  const { state } = session;
  const id = click.customId;
  const gid = session.guildId;
  const uid = session.user.id;

  // Modal z nazwą trzeba pokazać od razu (bez deferUpdate)
  if (id === 'bd_new') {
    const modal = new ModalBuilder()
      .setCustomId('bd_name_modal')
      .setTitle('Nowa banda')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('name').setLabel('Nazwa bandy (3-20 znaków)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(3).setMaxLength(20),
        ),
      );
    await click.showModal(modal);
    const sub = await click.awaitModalSubmit({ time: 120_000, filter: (i) => i.customId === 'bd_name_modal' && i.user.id === click.user.id }).catch(() => null);
    if (!sub) return;
    await sub.deferUpdate();
    const r = await crime.createGang(gid, uid, sub.fields.getTextInputValue('name'));
    if (r.ok) {
      state.gangId = r.id;
      state.view = 'main';
      state.notice = `✅ Założono bandę **${r.name}**. Zaproś kogoś z listy poniżej.`;
    } else state.notice = ERRORS[r.reason] ?? '❌ Nie udało się założyć bandy.';
    return render(session);
  }

  await click.deferUpdate();
  state.notice = null;
  if (id !== 'bd_leave' && id !== 'bd_disband') state.confirm = null;

  if (id === 'bd_close') {
    session.collector?.stop('closed');
    return session.interaction.editReply(farewell('🕵️ Menu bandy zamknięte. Wpisz `/banda`, żeby wrócić.'));
  }
  if (id === 'bd_refresh' || id === 'bd_back' || id === 'bd_cancel') {
    state.view = 'main';
    return render(session);
  }
  if (id === 'bd_invites') {
    state.view = 'invites';
    return render(session);
  }
  if (id === 'bd_pick') {
    state.gangId = Number(click.values[0]);
    return render(session);
  }
  if (id === 'bd_invite') {
    const targetId = click.values[0];
    const target = click.users?.get(targetId);
    if (target?.bot) state.notice = '🚫 Bot nie może być w bandzie.';
    else if (targetId === uid) state.notice = '⚠️ Już jesteś w tej bandzie.';
    else {
      const r = await crime.invite(gid, state.gangId, uid, targetId);
      if (r.ok) {
        state.notice = `✉️ Zaproszono <@${targetId}> do bandy **${r.gangName}**. Zaproszenie widać w \`/banda\` → Zaproszenia.`;
        session.interaction.channel?.send({ content: `🕵️ <@${targetId}>, <@${uid}> zaprasza cię do bandy **${r.gangName}**. Wpisz \`/banda\` → Zaproszenia (ważne 48 h).`, allowedMentions: { users: [targetId] } }).catch(() => null);
      } else state.notice = ERRORS[r.reason] ?? '❌ Nie udało się zaprosić.';
    }
    return render(session);
  }
  if (id === 'bd_kick') {
    const r = await crime.kick(gid, uid, state.gangId, click.values[0]);
    state.notice = r.ok ? `🥾 Wyrzucono <@${click.values[0]}> z bandy **${r.name}**.` : ERRORS[r.reason] ?? '❌ Nie udało się.';
    return render(session);
  }
  if (id === 'bd_leave' || id === 'bd_disband') {
    state.confirm = id === 'bd_leave' ? 'leave' : 'disband';
    return render(session);
  }
  if (id === 'bd_do_leave') {
    const r = await crime.leave(gid, uid, state.gangId);
    state.notice = r.ok ? (r.disbanded ? `🚪 Wyszedłeś z bandy **${r.name}** (byłeś ostatni, banda przestała istnieć).` : `🚪 Wyszedłeś z bandy **${r.name}**.${r.newLeader ? ` Nowy lider: <@${r.newLeader}>.` : ''}`) : ERRORS[r.reason] ?? '❌ Nie udało się.';
    state.gangId = null;
    return render(session);
  }
  if (id === 'bd_do_disband') {
    const r = await crime.disband(gid, uid, state.gangId);
    state.notice = r.ok ? `💥 Banda **${r.name}** została rozwiązana.` : ERRORS[r.reason] ?? '❌ Nie udało się.';
    state.gangId = null;
    return render(session);
  }
  if (id.startsWith('bd_acc:')) {
    const r = await crime.acceptInvite(gid, uid, Number(id.slice('bd_acc:'.length)));
    state.notice = r.ok ? `✅ Dołączyłeś do bandy **${r.name}**.` : ERRORS[r.reason] ?? '❌ Nie udało się.';
    if (r.ok) state.view = 'main';
    return render(session);
  }
  if (id.startsWith('bd_dec:')) {
    await crime.declineInvite(gid, uid, Number(id.slice('bd_dec:'.length)));
    state.notice = '✖️ Zaproszenie odrzucone.';
    return render(session);
  }
  return render(session);
}

async function openMenu(interaction) {
  if (!interaction.guild) {
    await interaction.reply({ content: 'Bandy działają tylko na serwerze.', flags: MessageFlags.Ephemeral });
    return;
  }
  await crime.ensureSchema();
  const session = newSession(interaction);
  // Nazwy do listy "Wyrzuć" (bez dodatkowych zapytań w trakcie)
  session.names = {};
  await interaction.reply({ ...(await buildPanel(session)), flags: V2 | MessageFlags.Ephemeral });
  const message = await interaction.fetchReply();

  const collector = message.createMessageComponentCollector({ filter: (i) => i.user.id === interaction.user.id, idle: IDLE_MS, time: MAX_MS });
  session.collector = collector;
  collector.on('collect', (click) => {
    onClick(click, session).catch(async (err) => {
      console.error('Banda: błąd obsługi kliknięcia:', err);
      const payload = { content: '❌ Coś poszło nie tak. Wpisz `/banda` i sprawdź stan.', flags: MessageFlags.Ephemeral };
      if (click.replied || click.deferred) await click.followUp(payload).catch(() => null);
      else await click.reply(payload).catch(() => null);
    });
  });
  collector.on('end', async (_c, reason) => {
    if (reason === 'closed') return;
    await interaction.editReply(farewell('⌛ Menu bandy wygasło. Wpisz `/banda`, żeby wrócić.')).catch(() => null);
  });
}

module.exports = {
  data: new SlashCommandBuilder().setName('banda').setDescription('Bandy: załóż grupę przestępczą, zapraszaj graczy i planuj duże skoki.').setDMPermission(false),
  async execute(interaction) {
    await openMenu(interaction);
  },
  openMenu,
  _test: { buildPanel, onClick, newSession },
};
