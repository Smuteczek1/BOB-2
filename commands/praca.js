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
  MessageFlags,
} = require('discord.js');
const db = require('../db');
const jobs = require('../utils/jobs');
const work = require('../utils/work');
const games = require('../utils/workGames');
const items = require('../utils/items');
const inventory = require('../utils/inventory');
const itemUse = require('../utils/itemUse');

// ============================================================
//  /praca: prywatne menu pracy (Components V2, jak /sklep i /rynek).
//  Główny ekran (status, energia, zmiana czasowa, zadanie), Oferty pracy, mini-gra (zadanie).
//  Logika, energia i wypłaty: utils/work.js. Katalog prac: utils/jobs.js. Mini-gry: utils/workGames.js.
// ============================================================

const V2 = MessageFlags.IsComponentsV2;
const IDLE_MS = 5 * 60_000;
const MAX_MS = 14 * 60_000;

const text = (s) => new TextDisplayBuilder().setContent(s);
const sep = () => new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small);
const coin = (n) => `**${Number(n).toLocaleString('pl-PL')}** 🪙`;
const GAME_NAMES = { memory: '🧠 pamięć', math: '🧮 rachunki', pick: '🔍 dopasuj' };
const ts = (ms) => Math.floor(ms / 1000);
const btn = (id, label, style = ButtonStyle.Secondary, { emoji, disabled = false } = {}) => {
  const b = new ButtonBuilder().setCustomId(id).setStyle(style).setDisabled(disabled);
  if (label) b.setLabel(label.slice(0, 80));
  if (emoji) b.setEmoji(emoji);
  return b;
};

function energyBar(left, max) {
  const filled = Math.max(0, Math.min(10, Math.round((left / max) * 10)));
  return `${'🟩'.repeat(filled)}${'⬜'.repeat(10 - filled)}`;
}

const ERRORS = {
  no_job: 'Najpierw znajdź pracę w „Oferty pracy”.',
  shift_active: 'Masz już zmianę w toku.',
  benefit: 'Dziś pobrano zasiłek, więc nie można już dziś pracować. Wróć jutro.',
  same: 'To już twoja praca.',
  unknown: 'Nie znam takiej pracy.',
  not_offered: 'Tej pracy nie ma dziś w twoich ofertach.',
  changed_today: 'Pracę możesz zmienić tylko raz dziennie. Spróbuj jutro.',
  has_job: 'Zasiłek należy się tylko bezrobotnym. Najpierw rzuć pracę.',
  already: 'Zasiłek już dziś odebrano.',
  worked: 'Dziś już pracowano, więc zasiłek się nie należy.',
  none: 'Nie masz zmiany do odebrania.',
  no_order: 'Nie ma takiego zlecenia.',
  order_done: 'To zlecenie już wykonano. Za chwilę pojawią się nowe.',
  gone: 'To zadanie jest już nieaktualne (rozliczone albo przerwane).',
};
function errorText(r) {
  if (r.reason === 'energy') return `⚡ Za mało energii (potrzeba ${r.need}, masz ${r.left}).${r.nextAt ? ` Następny punkt <t:${ts(r.nextAt)}:R>.` : ''} Pomoże Kawa albo Energetyk z ekwipunku.`;
  if (r.reason === 'cooldown') return `⏳ Przerwa między zadaniami: następne zadanie lub zlecenie <t:${ts(r.readyAt)}:R>. Karta przerwy kończy ją od razu.`;
  if (r.reason === 'level') return `🔒 Ta praca wymaga poziomu serwerowego **${r.need}**. XP zdobywasz pisząc, rozmawiając na kanałach głosowych i pracując.`;
  if (r.reason === 'not_yet') return `⏳ Zmiana jeszcze trwa. Skończy się <t:${ts(r.endsAt)}:R>.`;
  return `⚠️ ${ERRORS[r.reason] ?? 'Nie udało się.'}`;
}

function newSession(interaction) {
  return {
    interaction,
    guildId: interaction.guild.id,
    user: interaction.user,
    collector: null,
    state: { view: 'main', notice: null, run: null },
  };
}

// ---------------- WIDOKI ----------------
async function balanceOf(session) {
  const acc = await db.getEconomyAccount(session.guildId, session.user.id);
  return Number(acc?.balance ?? 0);
}

function jobStatusBlock(st) {
  if (!st.jobId) {
    return `### 🧑‍💼 Bezrobotny\nZnajdź pracę w **Oferty pracy**. Do tego czasu możesz odebrać zasiłek (${coin(jobs.BENEFIT)}), ale wtedy dziś nie popracujesz.`;
  }
  const job = jobs.JOBS[st.jobId];
  const shifts = st.career[st.jobId] ?? 0;
  const rank = jobs.rankInfo(st.jobId, shifts, st.gear.promo);
  const progress = rank.next ? `Zmiany: **${shifts}** / ${rank.next.shifts} do stopnia „${rank.next.name}”` : `Zmiany: **${shifts}** · najwyższy stopień!`;
  const pb = 1 + st.gear.payPct / 100;
  const pay = Math.round(jobs.payFor(st.jobId, shifts, 1, st.gear.promo) * pb);
  return (
    `### ${job.emoji} ${rank.name}\n${job.name} · stopień **${rank.idx + 1}/5** · mnożnik wypłaty ×${rank.mult}\n${progress}\n` +
    `💰 Zmiana: ${coin(pay)} · zadanie: ${coin(Math.round(jobs.payFor(st.jobId, shifts, jobs.TASK_MULT[0], st.gear.promo) * pb))}–${coin(Math.round(jobs.payFor(st.jobId, shifts, jobs.TASK_MULT[3], st.gear.promo) * pb))}\n` +
    `-# ⚡ koszt ${job.energy} · ⏳ zmiana czasowa ${job.minutes} min · zadanie: ${GAME_NAMES[job.game]} · +${jobs.xpFor(job.id)} XP (zadanie +${jobs.xpFor(job.id, true)})`
  );
}

async function mainView(session, box, st, disabled) {
  const balance = await balanceOf(session);
  box.addTextDisplayComponents(text(`## 💼 Praca\n-# Poziom serwerowy: **${st.level}** · saldo: ${coin(balance)}`));
  box.addSeparatorComponents(sep());
  box.addTextDisplayComponents(text(jobStatusBlock(st)));
  const regenInfo = st.nextEnergyAt ? ` · następny punkt <t:${ts(st.nextEnergyAt)}:R>` : ' · pełny zapas';
  const g = st.gear;
  const gear = [
    g.levels.krzeslo ? `🪑${g.levels.krzeslo}` : null, g.levels.ekspres ? `🫖${g.levels.ekspres}` : null,
    g.xpPct ? `🧠 +${g.xpPct}% XP` : null, g.payPct ? `💼 +${g.payPct}% monet` : null,
    g.levels.zegarek ? `⏱️ przerwa ${g.cooldownMin} min` : null, g.promoPct ? `🏆 awans -${g.promoPct}% zmian` : null, g.batteryPct ? `🔋 +${g.batteryPct}% energii z napojów` : null,
  ].filter(Boolean).join(' · ');
  box.addTextDisplayComponents(
    text(`⚡ Energia: ${energyBar(st.energyLeft, st.energyMax)} **${st.energyLeft}/${st.energyMax}**\n-# Regeneracja: **+${st.regenPerHour}/h**${regenInfo}${gear ? ` · ${gear}` : ''}`),
  );
  const notes = [];
  if (st.taskReadyAt > Date.now()) notes.push(`⏳ Przerwa między zadaniami: gotowe <t:${ts(st.taskReadyAt)}:R>`);
  if (st.boostPay) notes.push(`💵 Aktywna premia: +${st.boostPay}% monet`);
  if (st.boostXp) notes.push(`🎓 Aktywne szkolenie: +${st.boostXp}% XP`);
  if (notes.length) box.addTextDisplayComponents(text(notes.join('\n')));

  const job = st.jobId ? jobs.JOBS[st.jobId] : null;
  const shift = st.activeShift;
  if (shift?.mode === 'timed') {
    const sj = jobs.JOBS[shift.jobId];
    box.addTextDisplayComponents(text(`### ⏳ Zmiana w toku\n${sj.emoji} ${sj.name}: koniec <t:${ts(shift.endsAt)}:R>. Do odebrania ${coin(shift.pay)} i **${shift.xp} XP**.`));
  } else if (shift?.mode === 'task') {
    box.addTextDisplayComponents(text('### 🎮 Rozpoczęte zadanie\nNie dokończono go. Przepadnie, jeśli go nie ukończysz (energia nie wraca). Możesz je przerwać.'));
  }

  const busy = Boolean(shift);
  const canStart = Boolean(job) && !busy && !st.benefitTaken && st.energyLeft >= (job?.energy ?? 0);
  box.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      btn('pr_start_timed', 'Zmiana czasowa', ButtonStyle.Primary, { emoji: '⏳', disabled: disabled || !canStart }),
      btn('pr_start_task', 'Zadanie (mini-gra)', ButtonStyle.Success, { emoji: '🎮', disabled: disabled || !canStart }),
      ...(shift?.mode === 'timed' ? [btn('pr_collect', 'Odbierz', ButtonStyle.Success, { emoji: '📥', disabled })] : []),
      ...(shift?.mode === 'task' ? [btn('pr_giveup', 'Przerwij zadanie', ButtonStyle.Danger, { emoji: '🛑', disabled })] : []),
    ),
  );
  box.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      btn('pr_orders', 'Zlecenia', ButtonStyle.Primary, { emoji: '📋', disabled }),
      btn('pr_offers', 'Oferty pracy', ButtonStyle.Secondary, { emoji: '🔎', disabled }),
      btn('pr_items', 'Przedmioty', ButtonStyle.Secondary, { emoji: '🎒', disabled }),
      btn('pr_refresh', 'Odśwież', ButtonStyle.Secondary, { emoji: '🔄', disabled }),
      btn('pr_close', 'Zamknij', ButtonStyle.Danger, { emoji: '✖️', disabled }),
    ),
  );
  box.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      job
        ? btn('pr_quit', 'Rzuć pracę', ButtonStyle.Secondary, { emoji: '🚪', disabled: disabled || busy })
        : btn('pr_benefit', `Zasiłek (+${jobs.BENEFIT})`, ButtonStyle.Secondary, { emoji: '💰', disabled: disabled || st.benefitTaken || st.workedToday }),
    ),
  );
  if (st.benefitTaken) box.addTextDisplayComponents(text('-# 💤 Dziś pobrano zasiłek: pracować możesz dopiero jutro.'));
}

async function offersView(session, box, st, disabled) {
  box.addTextDisplayComponents(
    text(
      '## 🔎 Oferty pracy\n-# Lista jest losowa, inna dla każdego i zmienia się codziennie. Pracę możesz zmienić raz dziennie. ' +
      'Staż w każdej pracy zostaje zapamiętany, a awanse dają wyższe wypłaty.',
    ),
  );
  box.addSeparatorComponents(sep());

  const list = st.offers.filter((id) => id !== st.jobId);
  if (st.jobId) {
    const cur = jobs.JOBS[st.jobId];
    box.addTextDisplayComponents(text(`-# Twoja obecna praca: ${cur.emoji} **${cur.name}** (nie ma jej na liście ofert)`));
  }
  for (const id of list) {
    const job = jobs.JOBS[id];
    const shifts = st.career[id] ?? 0;
    const locked = st.level < job.minLevel;
    const veteran = shifts > 0 ? ` · twój staż: **${jobs.rankInfo(id, shifts).name}** (${shifts} zmian)` : '';
    const maxPay = jobs.payFor(id, jobs.RANK_SHIFTS[4]);
    box.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          text(
            `${locked ? '🔒' : job.emoji} **${job.name}** · poziom ${job.minLevel}+\n${job.desc}\n` +
            `-# ⚡ ${job.energy} · ${coin(jobs.payFor(id, shifts))} za zmianę (do ${coin(maxPay)} na szczycie) · ${GAME_NAMES[job.game]}${veteran}`,
          ),
        )
        .setButtonAccessory(
          btn(`pr_take:${id}`, locked ? `Poziom ${job.minLevel}` : 'Przyjmij', locked ? ButtonStyle.Secondary : ButtonStyle.Success, {
            emoji: locked ? '🔒' : '✅',
            disabled: disabled || locked || st.changedToday || Boolean(st.activeShift),
          }),
        ),
    );
  }
  if (list.length === 0) box.addTextDisplayComponents(text('_Dziś nie ma nowych ofert._'));
  if (st.changedToday) box.addTextDisplayComponents(text('-# Dziś zmieniono już pracę. Kolejna zmiana możliwa jutro.'));

  box.addActionRowComponents(new ActionRowBuilder().addComponents(btn('pr_back', 'Wróć', ButtonStyle.Secondary, { emoji: '◀️', disabled })));
}

function ordersView(session, box, st, disabled) {
  const next = (st.orderSlot + 1) * 3_600_000;
  box.addTextDisplayComponents(
    text(
      `## 📋 Zlecenia\n-# Każdy dostaje co godzinę 3 losowe zlecenia o różnych tematach, niezależnie od zawodu. Nagroda zależy od twojego poziomu serwerowego (**${st.level}**). ` +
      `Nowa lista <t:${ts(next)}:R>. Przerwa między grami: ${st.gear.cooldownMin} min.`,
    ),
  );
  box.addSeparatorComponents(sep());
  if (st.taskReadyAt > Date.now()) box.addTextDisplayComponents(text(`-# ⏳ Przerwa: następna mini-gra <t:${ts(st.taskReadyAt)}:R>`));
  const busy = Boolean(st.activeShift);
  for (const o of st.orders) {
    const noEnergy = st.energyLeft < o.energy;
    const maxPay = Math.round(o.pay * jobs.TASK_MULT[3] * (1 + st.gear.payPct / 100));
    const maxXp = Math.round(o.xp * jobs.TASK_XP_BONUS * (1 + st.gear.xpPct / 100));
    box.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          text(
            `${o.done ? '✅' : o.theme.emoji} **${o.title}** · ${o.theme.name.toLowerCase()}\n` +
            `-# ${GAME_NAMES[o.theme.game]} · ${o.rounds} ${o.rounds === 1 ? 'runda' : 'rundy'} · ⚡ ${o.energy} · do ${coin(maxPay)} · do **${maxXp} XP**${o.done ? ' · wykonane' : ''}`,
          ),
        )
        .setButtonAccessory(
          btn(`pr_order:${o.idx}`, o.done ? 'Zrobione' : 'Start', ButtonStyle.Success, {
            emoji: o.done ? '✅' : '▶️',
            disabled: disabled || o.done || busy || noEnergy || st.benefitTaken,
          }),
        ),
    );
  }
  if (st.orders.every((o) => o.done)) box.addTextDisplayComponents(text(`_Wszystkie zlecenia wykonane. Nowe pojawią się <t:${ts(next)}:R>._`));
  box.addActionRowComponents(new ActionRowBuilder().addComponents(btn('pr_back', 'Wróć', ButtonStyle.Secondary, { emoji: '◀️', disabled })));
}

// Przedmioty do pracy, które masz w ekwipunku (jednorazowe: przycisk Użyj; stałe: tylko poziom)
async function itemsView(session, box, st, disabled) {
  const inv = await inventory.getInventory(session.guildId, session.user.id);
  const mine = inv.filter((r) => items.ITEMS[r.itemId]?.use?.type?.startsWith('work_') || items.ITEMS[r.itemId]?.workFamily);
  box.addTextDisplayComponents(text('## 🎒 Przedmioty do pracy\n-# Wypadają ze skrzyń. Kawa, Energetyk i spółka uzupełniają energię, a stałe przedmioty (krzesło, ekspres) działają same.'));
  box.addSeparatorComponents(sep());
  const perm = mine.filter((r) => items.ITEMS[r.itemId].workFamily);
  const use = mine.filter((r) => !items.ITEMS[r.itemId].workFamily).slice(0, 8);
  if (perm.length) box.addTextDisplayComponents(text(perm.map((r) => { const d = items.ITEMS[r.itemId]; return `${d.emoji} **${d.name}** · poziom **${r.quantity}/${d.maxLevel}**\n-# ${d.desc}`; }).join('\n')));
  for (const r of use) {
    const d = items.ITEMS[r.itemId];
    box.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(text(`${d.emoji} **${d.name}** ×${r.quantity}\n-# ${d.desc}`))
        .setButtonAccessory(btn(`pr_use:${d.id}`, 'Użyj', ButtonStyle.Success, { emoji: '✨', disabled })),
    );
  }
  if (mine.length === 0) box.addTextDisplayComponents(text('_Nie masz jeszcze żadnych przedmiotów do pracy._'));
  box.addActionRowComponents(new ActionRowBuilder().addComponents(btn('pr_back', 'Wróć', ButtonStyle.Secondary, { emoji: '◀️', disabled })));
}

function gameView(session, box, st, disabled) {
  const run = session.state.run;
  const job = run.order ? { emoji: run.order.theme.emoji, name: run.order.title } : jobs.JOBS[run.jobId];
  const round = run.game.rounds[run.round];
  box.addTextDisplayComponents(
    text(`## 🎮 ${run.order ? 'Zlecenie' : 'Zadanie'}: ${job.emoji} ${job.name}\n-# Runda **${run.round + 1}/${run.game.rounds.length}** · poprawnych: **${run.hits}** · wypłata zależy od wyniku (od ×${jobs.TASK_MULT[0]} do ×${jobs.TASK_MULT[3]})`),
  );
  box.addSeparatorComponents(sep());

  if (run.game.kind === 'memory') {
    if (run.phase === 'show') {
      box.addTextDisplayComponents(text(`### Zapamiętaj kolejność\n# ${round.seq.join('  ')}`));
      box.addActionRowComponents(new ActionRowBuilder().addComponents(btn('pr_memgo', 'Zapamiętałem!', ButtonStyle.Success, { emoji: '🧠', disabled })));
    } else {
      box.addTextDisplayComponents(text(`### Klikaj w tej samej kolejności\n# ${run.pressed.length ? run.pressed.join('  ') : '❔'}`));
      const row = (from, to) =>
        new ActionRowBuilder().addComponents(
          round.pool.slice(from, to).map((emoji, k) => btn(`pr_mem:${from + k}`, null, ButtonStyle.Secondary, { emoji, disabled: disabled || run.pressed.includes(emoji) })),
        );
      box.addActionRowComponents(row(0, 3), row(3, 6));
    }
  } else {
    box.addTextDisplayComponents(text(`### ${round.question}`));
    box.addActionRowComponents(
      new ActionRowBuilder().addComponents(round.options.map((o, i) => btn(`pr_ans:${i}`, o, ButtonStyle.Primary, { disabled }))),
    );
  }
  box.addActionRowComponents(new ActionRowBuilder().addComponents(btn('pr_giveup', 'Przerwij (bez wypłaty)', ButtonStyle.Danger, { emoji: '🛑', disabled })));
}

async function buildPanel(session, { disabled = false } = {}) {
  const { state } = session;
  const st = await work.getState(session.guildId, session.user.id);
  const box = new ContainerBuilder().setAccentColor(0xe67e22);

  if (state.notice) {
    box.addTextDisplayComponents(text(state.notice));
    box.addSeparatorComponents(sep());
  }
  if (state.view === 'game' && state.run) gameView(session, box, st, disabled);
  else if (state.view === 'offers') await offersView(session, box, st, disabled);
  else if (state.view === 'orders') ordersView(session, box, st, disabled);
  else if (state.view === 'items') await itemsView(session, box, st, disabled);
  else await mainView(session, box, st, disabled);

  return { components: [box], flags: V2 };
}

const farewell = (msg) => ({ components: [new ContainerBuilder().setAccentColor(0x95a5a6).addTextDisplayComponents(text(msg))], flags: V2 });

// ---------------- AKCJE ----------------
async function render(session) {
  const payload = await buildPanel(session);
  try {
    await session.interaction.editReply(payload);
  } catch {
    await new Promise((r) => setTimeout(r, 700));
    await session.interaction.editReply(payload);
  }
}

const resultText = (r) => {
  const lines = [];
  if (r.mode === 'task') lines.push(`${r.themeId ? '📋 Zlecenie' : '🎮 Zadanie'}: **${r.hits}/${r.rounds}** poprawnych (×${r.mult}) → ${coin(r.pay)} i **${r.xp} XP**.`);
  else lines.push(`📥 Odebrano ${coin(r.pay)} i **${r.xp} XP**.`);
  lines.push(`-# Saldo: ${coin(r.balance)}${r.shifts === null ? ' · zlecenia nie liczą się do kariery' : ` · zmian w tej pracy: ${r.shifts}`}`);
  if (r.rankUp) lines.push(`⭐ **Awans!** Jesteś teraz: **${r.rankUp.to}**. Wypłaty rosną!`);
  if (r.level && r.level.newLevel > r.level.oldLevel) lines.push(`🎉 Nowy poziom serwerowy: **${r.level.newLevel}**!`);
  return lines.join('\n');
};

// Zamyka rundę mini-gry: zalicza trafienie/pudło i przechodzi dalej albo rozlicza zadanie
async function endRound(session, hit, feedback, client) {
  const { state } = session;
  const run = state.run;
  if (hit) run.hits += 1;
  if (run.round + 1 < run.game.rounds.length) {
    run.round += 1;
    run.pressed = [];
    run.phase = run.game.kind === 'memory' ? 'show' : 'ask';
    state.notice = feedback;
    return;
  }
  const res = await work.finishTask(session.guildId, session.user.id, run.shiftId, run.hits, Date.now(), client);
  state.run = null;
  state.view = 'main';
  state.notice = res.ok ? `${feedback}\n${resultText(res)}` : `⚠️ ${ERRORS.gone}`;
}

async function onClick(click, session) {
  const { state } = session;
  const id = click.customId;
  await click.deferUpdate();
  const client = click.client ?? session.interaction.client;
  const uid = session.user.id;
  const gid = session.guildId;
  state.notice = null;

  if (id === 'pr_close') {
    session.collector?.stop('closed');
    return session.interaction.editReply(farewell('💼 Praca zamknięta. Wpisz `/praca`, żeby wrócić.'));
  }
  if (id === 'pr_refresh' || id === 'pr_back') {
    state.view = 'main';
    return render(session);
  }
  if (id === 'pr_orders') {
    state.view = 'orders';
    return render(session);
  }
  if (id === 'pr_items') {
    state.view = 'items';
    return render(session);
  }
  if (id.startsWith('pr_use:')) {
    const r = await itemUse.useItem(gid, uid, id.slice('pr_use:'.length));
    state.notice = r.ok ? `**${r.title}**\n${r.lines.join('\n')}` : `⚠️ ${r.message}`;
    return render(session);
  }
  if (id.startsWith('pr_order:')) {
    const r = await work.startOrder(gid, uid, Number(id.slice('pr_order:'.length)));
    if (!r.ok) {
      state.notice = errorText(r);
      return render(session);
    }
    const game = games.makeOrderGame(r.order.theme, r.rounds);
    state.run = { shiftId: r.shiftId, jobId: r.jobId, order: r.order, game, round: 0, hits: 0, pressed: [], phase: game.kind === 'memory' ? 'show' : 'ask' };
    state.view = 'game';
    state.notice = `📋 **${r.order.title}** rozpoczęte (⚡ -${r.cost}). Dokończ je, bo przerwane przepada. Następna mini-gra za ${r.cooldownMin} min.`;
    return render(session);
  }
  if (id === 'pr_offers') {
    state.view = 'offers';
    return render(session);
  }
  if (id.startsWith('pr_take:')) {
    const r = await work.takeJob(gid, uid, id.slice('pr_take:'.length));
    if (r.ok) {
      state.view = 'main';
      state.notice = `✅ Przyjęto pracę: ${jobs.JOBS[r.jobId].emoji} **${r.rank.name}**${r.shifts > 0 ? ` (twój staż: ${r.shifts} zmian)` : ''}. Powodzenia!`;
    } else state.notice = errorText(r);
    return render(session);
  }
  if (id === 'pr_quit') {
    const r = await work.quitJob(gid, uid);
    state.notice = r.ok ? '🚪 Rzucono pracę. Staż zostaje zapamiętany.' : errorText(r);
    return render(session);
  }
  if (id === 'pr_benefit') {
    const r = await work.claimBenefit(gid, uid);
    state.notice = r.ok ? `💰 Odebrano zasiłek: ${coin(r.amount)}. Dziś już nie popracujesz. Saldo: ${coin(r.balance)}` : errorText(r);
    return render(session);
  }
  if (id === 'pr_start_timed') {
    const r = await work.startTimed(gid, uid);
    state.notice = r.ok ? `${r.boosted.pay || r.boosted.xp ? '✨ Bonus z przedmiotu użyty.\n' : ''}⏳ Zmiana rozpoczęta (⚡ -${r.cost}). Wróć <t:${ts(r.endsAt)}:R> i kliknij **Odbierz**.` : errorText(r);
    return render(session);
  }
  if (id === 'pr_collect') {
    const r = await work.collectTimed(gid, uid, Date.now(), client);
    state.notice = r.ok ? resultText(r) : errorText(r);
    return render(session);
  }
  if (id === 'pr_start_task') {
    const r = await work.startTask(gid, uid);
    if (!r.ok) {
      state.notice = errorText(r);
      return render(session);
    }
    const game = games.makeGame(r.jobId);
    state.run = { shiftId: r.shiftId, jobId: r.jobId, game, round: 0, hits: 0, pressed: [], phase: game.kind === 'memory' ? 'show' : 'ask' };
    state.view = 'game';
    state.notice = `🎮 Zadanie rozpoczęte (⚡ -${r.cost}). Dokończ je, bo przerwane przepada. Następna mini-gra za ${r.cooldownMin} min.`;
    return render(session);
  }
  if (id === 'pr_giveup') {
    const run = state.run;
    const st = await work.getState(gid, uid);
    const shiftId = run?.shiftId ?? (st.activeShift?.mode === 'task' ? st.activeShift.id : null);
    if (shiftId) await work.abandonTask(gid, uid, shiftId);
    state.run = null;
    state.view = 'main';
    state.notice = '🛑 Zadanie przerwane. Energia nie wraca.';
    return render(session);
  }

  // ----- mini-gra -----
  const run = state.run;
  if (!run || state.view !== 'game') {
    state.view = 'main';
    return render(session);
  }
  const round = run.game.rounds[run.round];

  if (id === 'pr_memgo' && run.game.kind === 'memory') {
    run.phase = 'input';
    run.pressed = [];
    return render(session);
  }
  if (id.startsWith('pr_mem:') && run.game.kind === 'memory' && run.phase === 'input') {
    const emoji = round.pool[Number(id.slice('pr_mem:'.length))];
    if (emoji === undefined || run.pressed.includes(emoji)) return render(session);
    run.pressed.push(emoji);
    const status = games.checkMemory(round.seq, run.pressed);
    if (status === 'ok') return render(session);
    const hit = status === 'done';
    await endRound(session, hit, hit ? '✅ **Dobrze!** Kolejność zapamiętana.' : `❌ **Pomyłka.** Poprawna kolejność: ${round.seq.join(' ')}`, client);
    return render(session);
  }
  if (id.startsWith('pr_ans:') && run.game.kind !== 'memory') {
    const picked = Number(id.slice('pr_ans:'.length));
    const hit = picked === round.correct;
    await endRound(session, hit, hit ? '✅ **Dobrze!**' : `❌ **Źle.** Poprawna odpowiedź: **${round.options[round.correct]}**`, client);
    return render(session);
  }
  return render(session);
}

async function openMenu(interaction) {
  if (!interaction.guild) {
    await interaction.reply({ content: 'Prace działają tylko na serwerze.', flags: MessageFlags.Ephemeral });
    return;
  }
  await work.ensureSchema();
  const session = newSession(interaction);
  await interaction.reply({ ...(await buildPanel(session)), flags: V2 | MessageFlags.Ephemeral });
  const message = await interaction.fetchReply();

  const collector = message.createMessageComponentCollector({
    filter: (i) => i.user.id === interaction.user.id,
    idle: IDLE_MS,
    time: MAX_MS,
  });
  session.collector = collector;

  collector.on('collect', (click) => {
    onClick(click, session).catch(async (err) => {
      console.error('Praca: błąd obsługi kliknięcia:', err);
      const payload = { content: '❌ Coś poszło nie tak w pracy. Wpisz `/praca` i sprawdź stan.', flags: MessageFlags.Ephemeral };
      if (click.replied || click.deferred) await click.followUp(payload).catch(() => null);
      else await click.reply(payload).catch(() => null);
    });
  });

  collector.on('end', async (_c, reason) => {
    if (reason === 'closed') return;
    await interaction.editReply(farewell('⌛ Menu pracy wygasło. Wpisz `/praca`, żeby wrócić (niedokończone zadanie przepada).')).catch(() => null);
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('praca')
    .setDescription('Praca: zmiany, zadania i zlecenia, awanse, energia regenerująca się co godzinę.')
    .setDMPermission(false),

  async execute(interaction) {
    await openMenu(interaction);
  },

  openMenu,

  // Eksport do testów
  _test: { buildPanel, onClick, newSession },
};
