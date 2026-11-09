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
  MessageFlags,
} = require('discord.js');
const db = require('../db');
const items = require('../utils/items');
const inventory = require('../utils/inventory');
const crime = require('../utils/crime');
const games = require('../utils/workGames');
const H = require('../utils/heists');

// ============================================================
//  /napad: PRYWATNE menu napadów (Components V2) + publiczna zbiórka ekipy na kanale.
//  Małe napady: solo albo z ekipą z bandy (do 3 os.). Duże skoki: tylko ekipa z JEDNEJ bandy (3-8 os.), każdy gra swój etap.
//  Każdy etap to mini-gra (pamięć / rachunki / dopasowanie). Przedmioty wymagane przez napad zabiera się startującemu.
//  Porażka: grzywna (część salda, z limitem) i areszt (blokada /praca i napadów); łup to monety z gry (od Boba).
//  Logika, baza, bandy: utils/crime.js. Katalog: utils/heists.js.
// ============================================================

const V2 = MessageFlags.IsComponentsV2;
const IDLE_MS = 5 * 60_000;
const MAX_MS = 14 * 60_000;
const text = (s) => new TextDisplayBuilder().setContent(s);
const sep = () => new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small);
const coin = (n) => `**${Number(n).toLocaleString('pl-PL')}** 🪙`;
const range = ([a, b]) => `${a.toLocaleString('pl-PL')}–${b.toLocaleString('pl-PL')} 🪙`;
const ts = (ms) => Math.floor(ms / 1000);
const btn = (id, label, style = ButtonStyle.Secondary, { emoji, disabled = false } = {}) => {
  const b = new ButtonBuilder().setCustomId(id).setStyle(style).setDisabled(disabled);
  if (label) b.setLabel(label.slice(0, 80));
  if (emoji) b.setEmoji(emoji);
  return b;
};
const itemName = (id) => `${items.ITEMS[id]?.emoji ?? ''} ${items.ITEMS[id]?.name ?? id}`;

// Przedmioty, które liderowi brakują (do komunikatów)
const missingText = (missing) => Object.entries(missing).map(([id, n]) => `${itemName(id)} ×${n}`).join(', ');

function errorText(r, heist) {
  switch (r.reason) {
    case 'level': return `🔒 ${r.userId ? `<@${r.userId}> ma za niski poziom przestępczy` : 'Za niski poziom przestępczy'} (potrzeba **${r.need}**).`;
    case 'jail': return `🚔 ${r.userId ? `<@${r.userId}> jest` : 'Jesteś'} w areszcie do <t:${ts(r.until)}:t> (<t:${ts(r.until)}:R>).`;
    case 'cap': return `⛔ ${r.userId ? `<@${r.userId}> wykonał` : 'Wykonałeś'} już dzisiaj maksymalną liczbę napadów (${H.DAILY_LIMIT}).`;
    case 'items': return `🎒 Brakuje sprzętu: ${missingText(r.missing)}. Zdobędziesz go ze skrzyń albo na \`/rynek\`.`;
    case 'players': return `👥 Ten napad wymaga ekipy z bandy: ${heist.min}-${heist.max} osób.`;
    case 'not_member': return `🚫 <@${r.userId}> nie jest w tej bandzie.`;
    case 'gone': return '⌛ Ten napad już się zakończył.';
    default: return '⚠️ Nie udało się rozpocząć napadu.';
  }
}

// ---------------- SILNIK ETAPÓW (mini-gry) ----------------
// Gra ciąg etapów jednego gracza. prefix: początek customId przycisków (osobny dla menu i dla akcji ekipy).
class StageGame {
  constructor(heist, stageIdxs, prefix) {
    this.heist = heist;
    this.prefix = prefix;
    this.stages = stageIdxs.map((i) => {
      const [type, rounds] = heist.stages[i];
      const def = H.STAGE_TYPES[type];
      return { idx: i, def, rounds, game: games.makeOrderGame(def, rounds), hits: 0 };
    });
    this.cur = 0;
    this.round = 0;
    this.pressed = [];
    this.phase = this.stages[0].def.game === 'memory' ? 'show' : 'ask';
    this.done = false;
    this.last = null; // komunikat po ostatniej rundzie
  }

  get stage() { return this.stages[this.cur]; }

  summary() {
    const hits = this.stages.reduce((a, s) => a + s.hits, 0);
    const rounds = this.stages.reduce((a, s) => a + s.rounds, 0);
    return { hits, rounds, stagesPassed: this.stages.every((s) => H.stagePassed(s.hits, s.rounds)) };
  }

  // Dodaje do kontenera opis rundy i przyciski
  render(box, disabled = false) {
    const s = this.stage;
    const round = s.game.rounds[this.round];
    const p = this.prefix;
    box.addTextDisplayComponents(
      text(`## ${s.def.emoji} ${s.def.role}: ${s.def.name}\n-# Etap **${this.cur + 1}/${this.stages.length}** · runda **${this.round + 1}/${s.rounds}** · zaliczenie etapu: min. ${Math.ceil(s.rounds / 2)} poprawne`),
    );
    box.addSeparatorComponents(sep());
    if (s.game.kind === 'memory') {
      if (this.phase === 'show') {
        box.addTextDisplayComponents(text(`### Zapamiętaj kolejność\n# ${round.seq.join('  ')}`));
        box.addActionRowComponents(new ActionRowBuilder().addComponents(btn(`${p}memgo`, 'Zapamiętałem!', ButtonStyle.Success, { emoji: '🧠', disabled })));
      } else {
        box.addTextDisplayComponents(text(`### Klikaj w tej samej kolejności\n# ${this.pressed.length ? this.pressed.join('  ') : '❔'}`));
        const row = (a, b) => new ActionRowBuilder().addComponents(round.pool.slice(a, b).map((e, k) => btn(`${p}mem:${a + k}`, null, ButtonStyle.Secondary, { emoji: e, disabled: disabled || this.pressed.includes(e) })));
        box.addActionRowComponents(row(0, 3), row(3, 6));
      }
    } else {
      box.addTextDisplayComponents(text(`### ${round.question}`));
      box.addActionRowComponents(new ActionRowBuilder().addComponents(round.options.map((o, i) => btn(`${p}ans:${i}`, o, ButtonStyle.Primary, { disabled }))));
    }
  }

  // Obsługa kliknięcia. Zwraca { handled, note } (note: informacja zwrotna po rundzie)
  press(id) {
    if (this.done || !id.startsWith(this.prefix)) return { handled: false };
    const key = id.slice(this.prefix.length);
    const s = this.stage;
    const round = s.game.rounds[this.round];
    if (key === 'memgo' && s.game.kind === 'memory' && this.phase === 'show') {
      this.phase = 'input';
      this.pressed = [];
      return { handled: true, note: null };
    }
    if (key.startsWith('mem:') && s.game.kind === 'memory' && this.phase === 'input') {
      const emoji = round.pool[Number(key.slice(4))];
      if (emoji === undefined || this.pressed.includes(emoji)) return { handled: true, note: null };
      this.pressed.push(emoji);
      const status = games.checkMemory(round.seq, this.pressed);
      if (status === 'ok') return { handled: true, note: null };
      return { handled: true, note: this.endRound(status === 'done', status === 'done' ? '✅ **Dobrze!**' : `❌ **Pomyłka.** Poprawna kolejność: ${round.seq.join(' ')}`) };
    }
    if (key.startsWith('ans:') && s.game.kind !== 'memory') {
      const hit = Number(key.slice(4)) === round.correct;
      return { handled: true, note: this.endRound(hit, hit ? '✅ **Dobrze!**' : `❌ **Źle.** Poprawna odpowiedź: **${round.options[round.correct]}**`) };
    }
    return { handled: false };
  }

  endRound(hit, feedback) {
    const s = this.stage;
    if (hit) s.hits += 1;
    this.pressed = [];
    if (this.round + 1 < s.rounds) {
      this.round += 1;
      this.phase = s.game.kind === 'memory' ? 'show' : 'ask';
    } else if (this.cur + 1 < this.stages.length) {
      const passed = H.stagePassed(s.hits, s.rounds);
      this.cur += 1;
      this.round = 0;
      this.phase = this.stage.def.game === 'memory' ? 'show' : 'ask';
      feedback += `\n${passed ? '🟢' : '🔴'} Etap „${s.def.name}”: ${s.hits}/${s.rounds}`;
    } else {
      this.done = true;
      feedback += `\n${H.stagePassed(s.hits, s.rounds) ? '🟢' : '🔴'} Etap „${s.def.name}”: ${s.hits}/${s.rounds}`;
    }
    return feedback;
  }
}

// ---------------- WYNIK ----------------
// Dopisek o EXP przestępczym (i awansie), pusty gdy EXP = 0
const xpText = (e) => (e?.xp > 0 ? ` ✨ **+${e.xp} EXP**${e.level > e.oldLevel ? ` · 🆙 poziom przestępczy **${e.level}**!` : ''}` : '');

function outcomeLine(res, userId) {
  const e = res.players[userId];
  const h = res.heist;
  if (!e) return '';
  if (res.success) return `🎉 **${h.emoji} ${h.name}: udało się!** Łup: ${coin(e.loot)} (saldo: ${coin(e.balance)}).${xpText(e)}`;
  if (!e.passed) {
    const parts = [`🚨 **Wpadka!**`];
    if (e.fine > 0) parts.push(`${h.jail > 0 ? 'Grzywna' : 'Mandat'}: ${coin(e.fine)}.`);
    if (e.jailUntil) parts.push(`Areszt do <t:${ts(e.jailUntil)}:t> (<t:${ts(e.jailUntil)}:R>): w tym czasie nie działa \`/praca\` ani napady.`);
    return parts.join(' ');
  }
  return `💥 Ekipa nie dała rady, ale ty swój etap zaliczyłeś: bez kary, ale i bez łupu.${xpText(e)}`;
}

// ---------------- MENU PRYWATNE ----------------
function newSession(interaction) {
  return {
    interaction,
    guildId: interaction.guild.id,
    user: interaction.user,
    collector: null,
    state: { tab: 'small', crew: false, gangId: null, notice: null, run: null },
  };
}

async function mainPanel(session, disabled) {
  const { state } = session;
  const [profile, inv, gangs] = await Promise.all([
    crime.getProfile(session.guildId, session.user.id),
    inventory.getInventory(session.guildId, session.user.id),
    crime.getMyGangs(session.guildId, session.user.id),
  ]);
  const level = profile.level; // poziom przestępczy
  const owned = Object.fromEntries(inv.map((r) => [r.itemId, Number(r.quantity)]));
  const gang = gangs.find((g) => g.id === state.gangId) ?? gangs[0] ?? null;
  state.gangId = gang?.id ?? null;
  const crewMode = state.tab === 'big' || (state.crew && Boolean(gang));

  const box = new ContainerBuilder().setAccentColor(0xc0392b);
  if (state.notice) {
    box.addTextDisplayComponents(text(state.notice));
    box.addSeparatorComponents(sep());
  }
  const kit = ['wytrych', 'lom', 'krotkofalowka', 'mapa', 'przebranie'].map((id) => `${items.ITEMS[id].emoji}${owned[id] ?? 0}`).join(' ');
  box.addTextDisplayComponents(
    text(
      `## 🕵️ Napady\n-# Poziom przestępczy: **${level}** (EXP: ${profile.into}/${profile.need}) · napady dziś: **${profile.heistsToday}/${H.DAILY_LIMIT}** · sprzęt: ${kit}\n` +
      (profile.jailUntil ? `🚔 **Areszt** do <t:${ts(profile.jailUntil)}:t> (<t:${ts(profile.jailUntil)}:R>): nie możesz napadać ani pracować.` : `-# Porażka = grzywna i areszt (blokada \`/praca\`). Łup to monety od Boba.`),
    ),
  );
  box.addSeparatorComponents(sep());

  box.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      btn('np_tab_small', 'Małe napady', state.tab === 'small' ? ButtonStyle.Primary : ButtonStyle.Secondary, { emoji: '🏪', disabled }),
      btn('np_tab_big', 'Duże skoki', state.tab === 'big' ? ButtonStyle.Primary : ButtonStyle.Secondary, { emoji: '🏦', disabled }),
      ...(state.tab === 'small'
        ? [btn('np_crew', state.crew ? 'Tryb: z ekipą' : 'Tryb: solo', ButtonStyle.Secondary, { emoji: state.crew ? '👥' : '🧍', disabled: disabled || !gang })]
        : []),
    ),
  );
  if (gangs.length > 1) {
    box.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('np_gang')
          .setPlaceholder('Banda do skoków')
          .setDisabled(disabled)
          .addOptions(gangs.map((g) => ({ label: g.name.slice(0, 100), value: String(g.id), default: g.id === gang.id, description: `${g.members.length} os.` }))),
      ),
    );
  }
  if (state.tab === 'big' || state.crew) {
    box.addTextDisplayComponents(text(gang ? `-# Banda do skoków: **${gang.name}** (${gang.members.length} os. · doświadczenie bandy: **${gang.xp.toLocaleString('pl-PL')}** EXP). Zbiórka ekipy pojawi się na kanale.` : '-# Duże skoki wymagają bandy. Załóż ją lub dołącz przez `/banda`.'));
  }

  const list = H.HEIST_LIST.filter((h) => h.size === state.tab);
  for (const h of list) {
    const locked = level < h.minLevel;
    const needs = Object.entries(h.items).map(([id, n]) => `${(owned[id] ?? 0) >= n ? '✅' : '❌'}${items.ITEMS[id].emoji}×${n}`).join(' ');
    const stages = h.stages.map(([t, r]) => `${H.STAGE_TYPES[t].emoji}${r}`).join(' ');
    const who = h.size === 'big' ? `👥 ${h.min}-${h.max} os.` : crewMode ? `👥 do ${h.max} os. (+${H.CREW_BONUS * 100}% łupu za każdą dodatkową)` : '🧍 solo';
    box.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          text(
            `${locked ? '🔒' : h.emoji} **${h.name}** · poziom ${h.minLevel}+ · ${who}\n` +
            `-# ${h.desc}\n-# Sprzęt ${needs} · etapy ${stages} · łup ${range(h.loot)} · porażka: ${h.jail ? `areszt ${h.jail} min` : 'mandat'}`,
          ),
        )
        .setButtonAccessory(
          btn(`np_go:${h.id}`, locked ? `Poziom ${h.minLevel}` : crewMode ? 'Zbierz ekipę' : 'Start', locked ? ButtonStyle.Secondary : ButtonStyle.Danger, {
            emoji: locked ? '🔒' : crewMode ? '👥' : '🎯',
            disabled: disabled || locked || Boolean(profile.jailUntil) || (h.size === 'big' && !gang),
          }),
        ),
    );
  }
  box.addActionRowComponents(
    new ActionRowBuilder().addComponents(btn('np_refresh', 'Odśwież', ButtonStyle.Secondary, { emoji: '🔄', disabled }), btn('np_close', 'Zamknij', ButtonStyle.Danger, { emoji: '✖️', disabled })),
  );
  return box;
}

function gamePanel(session, disabled) {
  const { run } = session.state;
  const box = new ContainerBuilder().setAccentColor(0xc0392b);
  if (session.state.notice) {
    box.addTextDisplayComponents(text(session.state.notice));
    box.addSeparatorComponents(sep());
  }
  box.addTextDisplayComponents(text(`-# ${run.heist.emoji} **${run.heist.name}** · w trakcie akcji. Przerwanie = przepada sprzęt.`));
  run.game.render(box, disabled);
  return box;
}

async function buildPanel(session, { disabled = false } = {}) {
  const box = session.state.run ? gamePanel(session, disabled) : await mainPanel(session, disabled);
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

// Rozlicza napad solo i wraca do menu z wynikiem
async function finishSolo(session) {
  const { state } = session;
  const run = state.run;
  const res = await crime.settleRun({ guildId: session.guildId, runId: run.runId, results: { [session.user.id]: run.game.summary() } });
  state.run = null;
  state.notice = res.ok ? outcomeLine(res, session.user.id) : errorText({ reason: 'gone' });
}

async function startSolo(session, heist) {
  const { state } = session;
  const uid = session.user.id;
  const r = await crime.startRun({ guildId: session.guildId, heistId: heist.id, leaderId: uid, playerIds: [uid] });
  if (!r.ok) {
    state.notice = errorText(r, heist);
    return;
  }
  const idxs = H.assignStages(heist, 1)[0];
  state.run = { runId: r.runId, heist, game: new StageGame(heist, idxs, 'ng_') };
  state.notice = `🎯 **${heist.name}** rozpoczęty. Sprzęt zużyty. Powodzenia!`;
}

async function onClick(click, session) {
  const { state } = session;
  const id = click.customId;
  await click.deferUpdate();
  const prevRun = state.run;
  state.notice = null;

  if (id === 'np_close') {
    session.collector?.stop('closed');
    return session.interaction.editReply(farewell('🕵️ Menu napadów zamknięte. Wpisz `/napad`, żeby wrócić.'));
  }
  if (prevRun) {
    // trwa akcja solo: tylko przyciski gry
    const out = prevRun.game.press(id);
    if (out.handled) {
      if (out.note) state.notice = out.note;
      if (prevRun.game.done) {
        const note = state.notice;
        await finishSolo(session);
        state.notice = `${note}\n${state.notice}`;
      }
    }
    return render(session);
  }
  if (id === 'np_refresh') return render(session);
  if (id === 'np_tab_small' || id === 'np_tab_big') {
    state.tab = id === 'np_tab_small' ? 'small' : 'big';
    return render(session);
  }
  if (id === 'np_crew') {
    state.crew = !state.crew;
    return render(session);
  }
  if (id === 'np_gang') {
    state.gangId = Number(click.values[0]);
    return render(session);
  }
  if (id.startsWith('np_go:')) {
    const heist = H.HEISTS[id.slice('np_go:'.length)];
    if (!heist) return render(session);
    const gangs = await crime.getMyGangs(session.guildId, session.user.id);
    const gang = gangs.find((g) => g.id === state.gangId) ?? gangs[0] ?? null;
    const crewMode = heist.size === 'big' || (state.crew && gang);
    if (crewMode) {
      if (!gang) state.notice = errorText({ reason: 'players' }, heist);
      else state.notice = await openLobby(session, heist, gang);
    } else await startSolo(session, heist);
    return render(session);
  }
  return render(session);
}

// ---------------- ZBIÓRKA EKIPY (publiczna wiadomość na kanale) ----------------
let lastLobby = null; // tylko do testów
const busyGangs = new Set(); // banda ma naraz jedną zbiórkę/akcję
const busyUsers = new Set(); // gracz bierze udział naraz w jednej akcji

function lobbyPayload(lobby, { disabled = false, final = null } = {}) {
  const h = lobby.heist;
  const box = new ContainerBuilder().setAccentColor(final ? 0x7f8c8d : 0xc0392b);
  const roster = lobby.players.map((u) => `▫️ <@${u}>${u === lobby.leaderId ? ' 👑' : ''}${lobby.phase === 'action' ? ` ${lobby.status[u] ?? '⏳'}` : ''}`).join('\n');
  const stages = h.stages.map(([t, r]) => `${H.STAGE_TYPES[t].emoji} ${H.STAGE_TYPES[t].role} (${r})`).join(' · ');
  box.addTextDisplayComponents(
    text(
      `## ${h.emoji} ${h.name}: ${lobby.phase === 'lobby' ? 'zbiórka ekipy' : 'akcja trwa'}\n` +
      `-# Banda **${lobby.gang.name}** (doświadczenie: **${(lobby.gang.xp ?? 0).toLocaleString('pl-PL')}** EXP) · lider <@${lobby.leaderId}> · ekipa: **${lobby.players.length}** (wymagane ${h.min}-${h.max})\n` +
      `-# Sprzęt (zabiera się liderowi przy starcie): ${H.itemsText(h.items, Object.fromEntries(Object.keys(h.items).map((i) => [i, itemName(i)])))}\n-# Etapy: ${stages}\n-# Łup: ${range(h.loot)} na osobę · lider (płaci sprzętem) dostaje +${Math.round(H.LEADER_BONUS * 100)}%`,
    ),
  );
  box.addSeparatorComponents(sep());
  box.addTextDisplayComponents(text(roster));
  if (lobby.notice) box.addTextDisplayComponents(text(lobby.notice));
  if (final) {
    box.addSeparatorComponents(sep());
    box.addTextDisplayComponents(text(final));
  } else if (lobby.phase === 'lobby') {
    box.addTextDisplayComponents(text(`-# Zbiórka kończy się <t:${ts(lobby.endsAt)}:R>. Dołączać mogą członkowie bandy.`));
    box.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        btn('nl_join', 'Dołącz', ButtonStyle.Success, { emoji: '🙋', disabled }),
        btn('nl_leave', 'Wyjdź', ButtonStyle.Secondary, { emoji: '🚪', disabled }),
        btn('nl_start', `Start (${lobby.players.length}/${h.min}+)`, ButtonStyle.Danger, { emoji: '🎯', disabled: disabled || lobby.players.length < h.min }),
        btn('nl_cancel', 'Anuluj', ButtonStyle.Secondary, { emoji: '✖️', disabled }),
      ),
    );
  } else {
    box.addTextDisplayComponents(text(`-# Każdy uczestnik klika poniżej i gra swój etap (prywatnie). Czas na akcję: do <t:${ts(lobby.endsAt)}:t> (<t:${ts(lobby.endsAt)}:R>).`));
    box.addActionRowComponents(new ActionRowBuilder().addComponents(btn('nl_enter', 'Wejdź do akcji', ButtonStyle.Danger, { emoji: '🕵️', disabled })));
  }
  return { components: [box], flags: V2, allowedMentions: { parse: [] } };
}

// Otwiera zbiórkę na kanale; zwraca komunikat dla lidera
async function openLobby(session, heist, gang) {
  const guildId = session.guildId;
  const leaderId = session.user.id;
  const channel = session.interaction.channel;
  if (!channel?.send) return '⚠️ Nie mogę opublikować zbiórki na tym kanale.';
  const key = `${guildId}:${gang.id}`;
  if (busyGangs.has(key)) return '⏳ Ta banda ma już otwartą zbiórkę lub trwającą akcję.';
  if (busyUsers.has(`${guildId}:${leaderId}`)) return '⏳ Bierzesz już udział w innej akcji.';
  const profile = await crime.getProfile(guildId, leaderId);
  if (profile.jailUntil) return errorText({ reason: 'jail', until: profile.jailUntil });
  if (profile.left <= 0) return errorText({ reason: 'cap' });

  busyGangs.add(key);
  busyUsers.add(`${guildId}:${leaderId}`);
  const lobby = { heist, gang, leaderId, players: [leaderId], phase: 'lobby', endsAt: Date.now() + H.LOBBY_MS, notice: null, status: {}, results: {}, entered: new Set(), starting: false, runId: null, games: {} };
  lastLobby = lobby;
  let message;
  try {
    message = await channel.send(lobbyPayload(lobby));
  } catch (err) {
    busyGangs.delete(key);
    busyUsers.delete(`${guildId}:${leaderId}`);
    console.error('Napad: nie udało się opublikować zbiórki:', err);
    return '⚠️ Nie udało się opublikować zbiórki na kanale (brak uprawnień?).';
  }
  runLobby(session, lobby, message, key).catch((err) => console.error('Napad: błąd zbiórki:', err));
  return `📣 Zbiórka ekipy na **${heist.name}** opublikowana na kanale. Gdy będzie komplet (min. ${heist.min}), kliknij tam **Start**.`;
}

async function releaseLobby(lobby, key) {
  busyGangs.delete(key);
  for (const u of lobby.players) busyUsers.delete(`${lobby.guildId}:${u}`);
}

async function runLobby(session, lobby, message, key) {
  const guildId = session.guildId;
  lobby.guildId = guildId;
  const update = (opts) => message.edit(lobbyPayload(lobby, opts)).catch(() => null);
  const finish = async (finalText) => {
    await update({ final: finalText, disabled: true });
    releaseLobby(lobby, key);
  };

  const collector = message.createMessageComponentCollector({ time: H.LOBBY_MS + H.ACTION_MS + 60_000 });
  lobby.collector = collector;

  // koniec czasu zbiórki
  const lobbyTimer = setTimeout(() => {
    if (lobby.phase === 'lobby') {
      collector.stop('lobby_timeout');
    }
  }, H.LOBBY_MS);

  const settle = async () => {
    if (lobby.settled) return;
    lobby.settled = true;
    clearTimeout(lobby.actionTimer);
    const results = {};
    for (const u of lobby.players) results[u] = lobby.results[u] ?? { hits: 0, rounds: 1, stagesPassed: false };
    const res = await crime.settleRun({ guildId, runId: lobby.runId, results });
    if (!res.ok) return finish('⌛ Ten napad został już rozliczony.');
    const lines = lobby.players.map((u) => {
      const e = res.players[u];
      if (res.success) return `🎉 <@${u}>: łup ${coin(e.loot)}${xpText(e)}`;
      if (!e.passed) return `🚨 <@${u}>: wpadka${e.fine ? `, ${res.heist.jail ? 'grzywna' : 'mandat'} ${coin(e.fine)}` : ''}${e.jailUntil ? `, areszt do <t:${ts(e.jailUntil)}:t>` : ''}`;
      return `💥 <@${u}>: swój etap zaliczył(a), ale ekipa polegała${xpText(e)}`;
    });
    const head = res.success ? `### 🎉 Skok udany! ${res.heist.emoji} ${res.heist.name}` : `### 🚨 Skok nieudany: ${res.heist.emoji} ${res.heist.name}`;
    await finish(`${head}\n${lines.join('\n')}`);
  };

  collector.on('collect', async (click) => {
    try {
      const uid = click.user.id;
      const id = click.customId;
      if (lobby.phase === 'lobby') {
        if (id === 'nl_join') {
          await click.deferUpdate();
          const fail = (msg) => click.followUp({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => null);
          if (lobby.players.includes(uid)) return fail('Już jesteś w ekipie.');
          if (lobby.players.length >= lobby.heist.max) return fail('Ekipa jest pełna.');
          const gangs = await crime.getMyGangs(guildId, uid);
          if (!gangs.some((g) => g.id === lobby.gang.id)) return fail('Dołączyć mogą tylko członkowie tej bandy.');
          if (busyUsers.has(`${guildId}:${uid}`)) return fail('Bierzesz już udział w innej akcji.');
          const profile = await crime.getProfile(guildId, uid);
          if (profile.level < lobby.heist.minLevel) return fail(`Za niski poziom przestępczy (potrzeba ${lobby.heist.minLevel}).`);
          if (profile.jailUntil) return fail('Jesteś w areszcie.');
          if (profile.left <= 0) return fail('Wykonałeś już dzisiaj maksymalną liczbę napadów.');
          lobby.players.push(uid);
          busyUsers.add(`${guildId}:${uid}`);
          return update();
        }
        if (id === 'nl_leave') {
          await click.deferUpdate();
          if (uid === lobby.leaderId || !lobby.players.includes(uid)) return;
          lobby.players = lobby.players.filter((u) => u !== uid);
          busyUsers.delete(`${guildId}:${uid}`);
          return update();
        }
        if (id === 'nl_cancel' || id === 'nl_start') {
          if (uid !== lobby.leaderId) return click.reply({ content: 'Tylko lider może to zrobić.', flags: MessageFlags.Ephemeral });
          await click.deferUpdate();
          if (id === 'nl_cancel') {
            collector.stop('cancelled');
            return;
          }
          if (lobby.starting || lobby.players.length < lobby.heist.min) return;
          lobby.starting = true;
          const r = await crime.startRun({ guildId, heistId: lobby.heist.id, leaderId: lobby.leaderId, playerIds: lobby.players, gangId: lobby.gang.id });
          if (!r.ok) {
            lobby.starting = false;
            return click.followUp({ content: errorText(r, lobby.heist), flags: MessageFlags.Ephemeral }).catch(() => null);
          }
          clearTimeout(lobbyTimer);
          lobby.runId = r.runId;
          lobby.phase = 'action';
          lobby.endsAt = Date.now() + H.ACTION_MS;
          lobby.assign = H.assignStages(lobby.heist, lobby.players.length);
          lobby.notice = lobby.players.map((u, i) => `${lobby.assign[i].map((s) => H.STAGE_TYPES[lobby.heist.stages[s][0]].emoji).join('')} <@${u}>: ${lobby.assign[i].map((s) => H.STAGE_TYPES[lobby.heist.stages[s][0]].role).join(' + ')}`).join('\n');
          lobby.actionTimer = setTimeout(() => collector.stop('action_timeout'), H.ACTION_MS);
          await update();
          return;
        }
        return click.deferUpdate().catch(() => null);
      }

      // ---- faza akcji ----
      if (id === 'nl_enter') {
        const idx = lobby.players.indexOf(uid);
        if (idx < 0) return click.reply({ content: 'Nie jesteś w tej ekipie.', flags: MessageFlags.Ephemeral });
        if (lobby.entered.has(uid)) return click.reply({ content: 'Już wszedłeś do akcji. Poszukaj swojego prywatnego okna (albo poczekaj na wynik).', flags: MessageFlags.Ephemeral });
        lobby.entered.add(uid);
        lobby.status[uid] = '🎮';
        let stageGame;
        let build;
        try {
          stageGame = new StageGame(lobby.heist, lobby.assign[idx], 'ng_');
          lobby.games[uid] = stageGame;
          build = (note, disabled = false) => {
            const box = new ContainerBuilder().setAccentColor(0xc0392b);
            if (note) box.addTextDisplayComponents(text(note)), box.addSeparatorComponents(sep());
            box.addTextDisplayComponents(text(`-# ${lobby.heist.emoji} **${lobby.heist.name}** · twoje etapy w akcji ekipy. Zakończ przed <t:${ts(lobby.endsAt)}:t>.`));
            stageGame.render(box, disabled);
            return { components: [box], flags: V2 };
          };
          await click.reply({ ...build(null), flags: V2 | MessageFlags.Ephemeral });
        } catch (err) {
          // nie udało się uruchomić okna gry: zwalniamy gracza, żeby mógł kliknąć jeszcze raz (zamiast „już wszedłeś do akcji”)
          console.error('Napad: nie udało się wejść do akcji:', err);
          lobby.entered.delete(uid);
          delete lobby.status[uid];
          delete lobby.games[uid];
          if (!click.replied && !click.deferred) await click.reply({ content: '❌ Nie udało się uruchomić Twojego etapu. Kliknij „Wejdź do akcji” jeszcze raz.', flags: MessageFlags.Ephemeral }).catch(() => null);
          return;
        }
        update();
        const reply = await click.fetchReply();
        const pc = reply.createMessageComponentCollector({ filter: (i) => i.user.id === uid, idle: 5 * 60_000, time: H.ACTION_MS });
        const done = async () => {
          lobby.results[uid] = stageGame.summary();
          lobby.status[uid] = lobby.results[uid].stagesPassed ? '✅' : '❌';
          pc.stop('done');
          update();
          if (lobby.players.every((u) => lobby.results[u])) await settle();
        };
        pc.on('collect', async (pcClick) => {
          try {
            await pcClick.deferUpdate();
            const out = stageGame.press(pcClick.customId);
            if (stageGame.done) {
              const s = stageGame.summary();
              await click.editReply({ components: [new ContainerBuilder().setAccentColor(0x7f8c8d).addTextDisplayComponents(text(`${out.note ?? ''}\n${s.stagesPassed ? '🟢 Twoje etapy zaliczone.' : '🔴 Nie zaliczyłeś etapu.'} Wynik ekipy pojawi się na kanale.`))], flags: V2 }).catch(() => null);
              return done();
            }
            await click.editReply(build(out.note));
          } catch (err) {
            console.error('Napad: błąd etapu:', err);
          }
        });
        pc.on('end', (_c, reason) => {
          if (reason !== 'done' && !lobby.results[uid]) {
            // czas minął albo okno wygasło: etap niezaliczony
            lobby.results[uid] = { ...stageGame.summary(), stagesPassed: false };
            lobby.status[uid] = '❌';
            update();
            if (lobby.players.every((u) => lobby.results[u])) settle().catch((e) => console.error(e));
          }
        });
        return;
      }
      return click.deferUpdate().catch(() => null);
    } catch (err) {
      console.error('Napad: błąd w zbiórce/akcji:', err);
      if (lobby.phase === 'lobby') lobby.starting = false; // błąd przy starcie nie może zablokować kolejnej próby
      if (!click.replied && !click.deferred) await click.reply({ content: '❌ Coś poszło nie tak. Spróbuj ponownie.', flags: MessageFlags.Ephemeral }).catch(() => null);
    }
  });

  collector.on('end', async (_c, reason) => {
    clearTimeout(lobbyTimer);
    if (lobby.phase === 'lobby') {
      await finish(reason === 'cancelled' ? '✖️ Zbiórka anulowana przez lidera.' : '⌛ Zbiórka wygasła: nikt nie wystartował. Sprzęt nie został zużyty.');
    } else if (!lobby.settled) {
      // czas akcji minął: kto nie skończył, ten nie zaliczył
      for (const u of lobby.players) lobby.results[u] ??= { hits: 0, rounds: 1, stagesPassed: false };
      await settle().catch((e) => console.error('Napad: błąd rozliczenia:', e));
    }
  });
}

async function openMenu(interaction) {
  if (!interaction.guild) {
    await interaction.reply({ content: 'Napady działają tylko na serwerze.', flags: MessageFlags.Ephemeral });
    return;
  }
  await crime.ensureSchema();
  crime.sweepStale().catch(() => null);
  const session = newSession(interaction);
  await interaction.reply({ ...(await buildPanel(session)), flags: V2 | MessageFlags.Ephemeral });
  const message = await interaction.fetchReply();

  const collector = message.createMessageComponentCollector({ filter: (i) => i.user.id === interaction.user.id, idle: IDLE_MS, time: MAX_MS });
  session.collector = collector;
  collector.on('collect', (click) => {
    onClick(click, session).catch(async (err) => {
      console.error('Napad: błąd obsługi kliknięcia:', err);
      const payload = { content: '❌ Coś poszło nie tak. Wpisz `/napad` i sprawdź stan.', flags: MessageFlags.Ephemeral };
      if (click.replied || click.deferred) await click.followUp(payload).catch(() => null);
      else await click.reply(payload).catch(() => null);
    });
  });
  collector.on('end', async (_c, reason) => {
    if (reason === 'closed') return;
    await interaction.editReply(farewell('⌛ Menu napadów wygasło. Wpisz `/napad`, żeby wrócić. (Niedokończony napad solo przepada razem ze sprzętem.)')).catch(() => null);
  });
}

module.exports = {
  data: new SlashCommandBuilder().setName('napad').setDescription('Napady: małe solo albo z ekipą, duże skoki z bandą. Mini-gry, łup i ryzyko aresztu.').setDMPermission(false),
  async execute(interaction) {
    await openMenu(interaction);
  },
  openMenu,
  _test: { getLobby: () => lastLobby, buildPanel, onClick, newSession, StageGame, outcomeLine },
};
