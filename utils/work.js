const db = require('../db');
const jobs = require('./jobs');
const { levelForXp, announceIfMilestone } = require('./leveling');
const { syncLevelRole } = require('./levelRoles');

// ============================================================
//  PRACE: energia, zmiany, kariera, zasiłek.
//  Tabele tworzą się przy pierwszym użyciu (ensureSchema), więc nie trzeba zmieniać db.js.
//  Każda akcja to JEDNA transakcja z blokadą profilu gracza (FOR UPDATE): energia, wypłata i
//  licznik zmian nie rozjadą się nawet przy szybkim klikaniu lub kilku otwartych menu.
//
//  Energia: zapas regeneruje się CIĄGLE (domyślnie 5 na godzinę, bez resetu o północy) do maksimum (domyślnie 100).
//  Ergonomiczne krzesło podnosi maksimum, Ekspres do kawy podnosi regenerację (stałe przedmioty ze skrzyń).
//  Zadania i zlecenia (mini-gry) mają przerwę 10 minut od startu poprzedniej mini-gry. Zlecenia odświeżają się co godzinę.
//  Zmiana czasowa ('timed'): start (zużywa energię) -> po czasie odbiór (wypłata 100%).
//  Zadanie ('task'): start (zużywa energię od razu) -> mini-gra -> wypłata zależna od wyniku.
//  Przerwane zadanie przepada (energia zużyta, brak wypłaty), żeby nie dało się zadania "powtarzać do skutku".
// ============================================================

const TASK_STALE_MS = 15 * 60_000; // zadanie niedokończone po tylu minutach uznajemy za przerwane

let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = db.raw
      .query(`
        CREATE TABLE IF NOT EXISTS work_profiles (
          guild_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          job_id TEXT,
          day TEXT NOT NULL DEFAULT '',
          energy_used INT NOT NULL DEFAULT 0,
          offers_level INT NOT NULL DEFAULT 0,
          benefit_day TEXT,
          change_day TEXT,
          worked_day TEXT,
          PRIMARY KEY (guild_id, user_id)
        );
        ALTER TABLE work_profiles ADD COLUMN IF NOT EXISTS energy INT;
        ALTER TABLE work_profiles ADD COLUMN IF NOT EXISTS energy_at BIGINT NOT NULL DEFAULT 0;
        ALTER TABLE work_profiles ADD COLUMN IF NOT EXISTS task_ready_at BIGINT NOT NULL DEFAULT 0;
        ALTER TABLE work_profiles ADD COLUMN IF NOT EXISTS boost_pay INT NOT NULL DEFAULT 0;
        ALTER TABLE work_profiles ADD COLUMN IF NOT EXISTS boost_xp INT NOT NULL DEFAULT 0;
        CREATE TABLE IF NOT EXISTS work_career (
          guild_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          job_id TEXT NOT NULL,
          shifts INT NOT NULL DEFAULT 0,
          PRIMARY KEY (guild_id, user_id, job_id)
        );
        -- mode: timed | task; status: active | done | abandoned
        CREATE TABLE IF NOT EXISTS work_shifts (
          id BIGSERIAL PRIMARY KEY,
          guild_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          job_id TEXT NOT NULL,
          mode TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          started_at BIGINT NOT NULL,
          ends_at BIGINT,
          pay BIGINT NOT NULL,
          xp INT NOT NULL,
          earned BIGINT,
          closed_at BIGINT
        );
        ALTER TABLE work_shifts ADD COLUMN IF NOT EXISTS rounds INT NOT NULL DEFAULT 3;
        ALTER TABLE work_shifts ADD COLUMN IF NOT EXISTS order_slot BIGINT;
        ALTER TABLE work_shifts ADD COLUMN IF NOT EXISTS order_idx INT;
        -- zlecenia już podjęte w danej godzinie (slot = godzina od epoki): każde zlecenie tylko raz
        CREATE TABLE IF NOT EXISTS work_orders (
          guild_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          slot BIGINT NOT NULL,
          idx INT NOT NULL,
          PRIMARY KEY (guild_id, user_id, slot, idx)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_work_one_active ON work_shifts (guild_id, user_id) WHERE status = 'active';
      `)
      .catch((err) => {
        schemaReady = null;
        throw err;
      });
  }
  return schemaReady;
}

// Dzień kalendarzowy w Polsce (energia i zasiłek odnawiają się o północy czasu polskiego)
function dayKey(now = Date.now()) {
  return new Date(now).toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
}

// Poziomy stałych przedmiotów do pracy (poziom = ilość w ekwipunku)
const PERM_IDS = ['krzeslo', 'ekspres', 'notes', 'zlota_teczka', 'zegarek', 'dyplom', 'powerbank'];
async function permLevels(c, guildId, userId) {
  const res = await c.query('SELECT item_id, quantity FROM inventory WHERE guild_id = $1 AND user_id = $2 AND item_id = ANY($3::text[])', [guildId, userId, PERM_IDS]);
  const lv = Object.fromEntries(PERM_IDS.map((id) => [id, 0]));
  for (const r of res.rows) lv[r.item_id] = Number(r.quantity);
  return lv;
}

// Energia ciągła: co 1/regen godziny wraca 1 punkt, do maksimum. Nowy profil zaczyna z pełnym zapasem.
// Pełny zapas nie "odkłada" regeneracji (licznik czasu startuje od pierwszego wydania energii).
function regenerate(row, now) {
  const max = row.max_energy;
  if (row.energy === null || row.energy === undefined) row.energy = max;
  let at = Number(row.energy_at) || now;
  if (row.energy >= max) {
    at = now;
  } else {
    const step = 3_600_000 / row.regen;
    const units = Math.floor((now - at) / step);
    if (units > 0) {
      row.energy = Math.min(max, row.energy + units);
      at += units * step;
      if (row.energy >= max) at = now;
    }
  }
  row.energy_at = Math.round(at);
}

// Wczytuje (i w razie potrzeby tworzy / odnawia na nowy dzień) profil z blokadą wiersza. Tylko w transakcji.
async function loadProfile(c, guildId, userId, now) {
  const today = dayKey(now);
  await c.query('INSERT INTO work_profiles (guild_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [guildId, userId]);
  const row = (await c.query('SELECT * FROM work_profiles WHERE guild_id = $1 AND user_id = $2 FOR UPDATE', [guildId, userId])).rows[0];

  if (row.day !== today) {
    const lvl = await c.query('SELECT level FROM user_levels WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
    row.offers_level = Number(lvl.rows[0]?.level ?? 0);
    row.energy_used = 0;
    row.day = today;
    await c.query('UPDATE work_profiles SET day = $3, energy_used = 0, offers_level = $4 WHERE guild_id = $1 AND user_id = $2', [guildId, userId, today, row.offers_level]);
  }

  // Niedokończone zadania (mini-gra porzucona) przepadają
  await c.query(
    "UPDATE work_shifts SET status = 'abandoned', closed_at = $3::bigint WHERE guild_id = $1 AND user_id = $2 AND status = 'active' AND mode = 'task' AND started_at < $4::bigint",
    [guildId, userId, now, now - TASK_STALE_MS],
  );

  if (row.job_id && !jobs.JOBS[row.job_id]) row.job_id = null; // praca usunięta z katalogu

  // Stałe przedmioty (poziom = ilość w ekwipunku) i regeneracja energii do chwili "now"
  const lv = await permLevels(c, guildId, userId);
  row.gear = lv;
  row.chair = lv.krzeslo;
  row.espresso = lv.ekspres;
  row.max_energy = jobs.maxEnergy(row.chair);
  row.regen = jobs.regenPerHour(row.espresso);
  regenerate(row, now);
  await c.query('UPDATE work_profiles SET energy = $3, energy_at = $4::bigint WHERE guild_id = $1 AND user_id = $2', [guildId, userId, row.energy, row.energy_at]);
  return { row, today };
}

async function readState(c, guildId, userId, now) {
  const { row, today } = await loadProfile(c, guildId, userId, now);
  // Jedno połączenie w transakcji obsługuje zapytania po kolei (równoległe na tym samym kliencie są przestarzałe w pg)
  const lvl = await c.query('SELECT level FROM user_levels WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
  const career = await c.query('SELECT job_id, shifts FROM work_career WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
  const shift = await c.query("SELECT * FROM work_shifts WHERE guild_id = $1 AND user_id = $2 AND status = 'active'", [guildId, userId]);
  const doneOrders = await c.query('SELECT idx FROM work_orders WHERE guild_id = $1 AND user_id = $2 AND slot = $3::bigint', [guildId, userId, Math.floor(now / 3_600_000)]);
  const careerMap = Object.fromEntries(career.rows.map((r) => [r.job_id, Number(r.shifts)]));
  const s = shift.rows[0];
  return {
    today,
    jobId: row.job_id,
    level: Number(lvl.rows[0]?.level ?? 0),
    energyMax: row.max_energy,
    energyLeft: row.energy,
    regenPerHour: row.regen,
    chairLevel: row.chair,
    espressoLevel: row.espresso,
    gear: {
      xpPct: row.gear.notes * jobs.XP_PER_LEVEL,
      payPct: row.gear.zlota_teczka * jobs.PAY_PER_LEVEL,
      cooldownMin: Math.max(1, jobs.TASK_COOLDOWN_MIN - row.gear.zegarek * jobs.CLOCK_PER_LEVEL),
      promo: row.gear.dyplom,
      promoPct: row.gear.dyplom * jobs.PROMO_PER_LEVEL,
      batteryPct: row.gear.powerbank * jobs.BATTERY_PER_LEVEL,
      levels: row.gear,
    },
    nextEnergyAt: row.energy < row.max_energy ? Math.round(row.energy_at + 3_600_000 / row.regen) : null,
    taskReadyAt: Number(row.task_ready_at),
    boostPay: row.boost_pay,
    boostXp: row.boost_xp,
    orderSlot: Math.floor(now / 3_600_000),
    orders: jobs.ordersForSlot(guildId, userId, Math.floor(now / 3_600_000), Number(lvl.rows[0]?.level ?? 0), doneOrders.rows.map((r) => Number(r.idx))),
    offersLevel: row.offers_level,
    // oferty dnia nie zależą od obecnej pracy (lista jest stała w ciągu dnia); widok ukrywa tylko obecną pracę
    offers: jobs.offersFor(guildId, userId, today, row.offers_level, null),
    benefitTaken: row.benefit_day === today,
    changedToday: row.change_day === today,
    workedToday: row.worked_day === today,
    career: careerMap,
    activeShift: s
      ? { id: Number(s.id), mode: s.mode, jobId: s.job_id, startedAt: Number(s.started_at), endsAt: s.ends_at === null ? null : Number(s.ends_at), pay: Number(s.pay), xp: s.xp }
      : null,
  };
}

const getState = (guildId, userId, now = Date.now()) => db.withTransaction((c) => readState(c, guildId, userId, now));

// ---------------- ZMIANA PRACY ----------------
// reason: unknown | level (+need) | not_offered | same | changed_today | shift_active
async function takeJob(guildId, userId, jobId, now = Date.now()) {
  const job = jobs.JOBS[jobId];
  if (!job) return { ok: false, reason: 'unknown' };
  return db.withTransaction(async (c) => {
    const st = await readState(c, guildId, userId, now);
    if (st.jobId === jobId) return { ok: false, reason: 'same' };
    if (st.activeShift) return { ok: false, reason: 'shift_active' };
    if (!st.offers.includes(jobId)) return { ok: false, reason: 'not_offered' };
    if (st.level < job.minLevel) return { ok: false, reason: 'level', need: job.minLevel };
    if (st.changedToday) return { ok: false, reason: 'changed_today' };
    await c.query('UPDATE work_profiles SET job_id = $3, change_day = $4 WHERE guild_id = $1 AND user_id = $2', [guildId, userId, jobId, st.today]);
    const shifts = st.career[jobId] ?? 0;
    return { ok: true, jobId, shifts, rank: jobs.rankInfo(jobId, shifts) };
  });
}

// reason: no_job | shift_active
async function quitJob(guildId, userId, now = Date.now()) {
  return db.withTransaction(async (c) => {
    const st = await readState(c, guildId, userId, now);
    if (!st.jobId) return { ok: false, reason: 'no_job' };
    if (st.activeShift) return { ok: false, reason: 'shift_active' };
    await c.query('UPDATE work_profiles SET job_id = NULL WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
    return { ok: true, jobId: st.jobId };
  });
}

// ---------------- ZASIŁEK ----------------
// Tylko bez pracy, raz dziennie i tylko jeśli dziś jeszcze nie pracowałeś/aś. Potem dziś nie wolno już pracować.
// reason: has_job | already | worked
async function claimBenefit(guildId, userId, now = Date.now()) {
  return db.withTransaction(async (c) => {
    const st = await readState(c, guildId, userId, now);
    if (st.jobId) return { ok: false, reason: 'has_job' };
    if (st.benefitTaken) return { ok: false, reason: 'already' };
    if (st.workedToday) return { ok: false, reason: 'worked' };
    const balance = await db.applyCredit(c, guildId, userId, jobs.BENEFIT, 'work_benefit', true);
    await c.query('UPDATE work_profiles SET benefit_day = $3 WHERE guild_id = $1 AND user_id = $2', [guildId, userId, st.today]);
    return { ok: true, amount: jobs.BENEFIT, balance };
  });
}

// ---------------- ZMIANY ----------------
// Wspólne sprawdzenia przed startem zmiany czasowej, zadania lub zlecenia
// cost: koszt energii; game: true dla mini-gier (zadanie, zlecenie), które mają przerwę między sobą
function startChecks(st, now, { cost = null, game = false, needJob = true } = {}) {
  if (needJob && !st.jobId) return { ok: false, reason: 'no_job' };
  if (st.activeShift) return { ok: false, reason: 'shift_active' };
  if (st.benefitTaken) return { ok: false, reason: 'benefit' };
  if (game && st.taskReadyAt > now) return { ok: false, reason: 'cooldown', readyAt: st.taskReadyAt };
  const need = cost ?? jobs.JOBS[st.jobId].energy;
  if (st.energyLeft < need) return { ok: false, reason: 'energy', need, left: st.energyLeft, nextAt: st.nextEnergyAt };
  return { ok: true, cost: need };
}

// kind: 'timed' | 'task' | 'order' (+ orderIdx). Wypłata i XP uwzględniają aktywną Premię / Szkolenie (zużywane przy starcie).
async function beginShift(guildId, userId, kind, now, orderIdx = null) {
  return db.withTransaction(async (c) => {
    const st = await readState(c, guildId, userId, now);
    const job = st.jobId ? jobs.JOBS[st.jobId] : null;
    const shifts = job ? st.career[job.id] ?? 0 : 0;
    let order = null;
    if (kind === 'order') {
      order = st.orders.find((o) => o.idx === orderIdx);
      if (!order) return { ok: false, reason: 'no_order' };
      if (order.done) return { ok: false, reason: 'order_done' };
    }
    const chk = startChecks(st, now, { cost: order ? order.energy : null, game: kind !== 'timed', needJob: !order });
    if (!chk.ok) return chk;

    let pay = order ? order.pay : jobs.payFor(job.id, shifts, 1, st.gear.promo); // zadanie mnoży wypłatę potem przez wynik
    let xp = order ? order.xp : jobs.xpFor(job.id, kind === 'task');
    // Premia / Szkolenie (jednorazowe) mnożą razem ze stałymi Złotą teczką / Notesem mistrza
    pay = Math.max(1, Math.round(pay * (1 + st.boostPay / 100) * (1 + st.gear.payPct / 100)));
    xp = Math.max(1, Math.round(xp * (1 + st.boostXp / 100) * (1 + st.gear.xpPct / 100)));
    const rounds = order ? order.rounds : jobs.ROUNDS;
    const endsAt = kind === 'timed' ? now + job.minutes * 60_000 : null;
    const readyAt = kind === 'timed' ? st.taskReadyAt : now + st.gear.cooldownMin * 60_000;

    await c.query(
      `UPDATE work_profiles SET energy = energy - $3, worked_day = $4, boost_pay = 0, boost_xp = 0, task_ready_at = $5::bigint
       WHERE guild_id = $1 AND user_id = $2`,
      [guildId, userId, chk.cost, st.today, readyAt],
    );
    if (order) await c.query('INSERT INTO work_orders (guild_id, user_id, slot, idx) VALUES ($1, $2, $3::bigint, $4)', [guildId, userId, order.slot, order.idx]);
    const ins = await c.query(
      `INSERT INTO work_shifts (guild_id, user_id, job_id, mode, started_at, ends_at, pay, xp, rounds, order_slot, order_idx)
       VALUES ($1, $2, $3, $4, $5::bigint, $6::bigint, $7::bigint, $8, $9, $10::bigint, $11) RETURNING id`,
      [guildId, userId, order ? `zlec_${order.themeId}` : job.id, kind === 'timed' ? 'timed' : 'task', now, endsAt, pay, xp, rounds, order?.slot ?? null, order?.idx ?? null],
    );
    return {
      ok: true, shiftId: Number(ins.rows[0].id), jobId: order ? null : job.id, order, cost: chk.cost, pay, xp, endsAt, rounds,
      energyLeft: st.energyLeft - chk.cost, cooldownMin: st.gear.cooldownMin, readyAt: kind === 'timed' ? null : readyAt,
      boosted: { pay: st.boostPay, xp: st.boostXp },
    };
  });
}

// reason: no_job | shift_active | benefit | energy (+need, left, nextAt) | cooldown (+readyAt) | no_order | order_done
const startTimed = (guildId, userId, now = Date.now()) => beginShift(guildId, userId, 'timed', now);
const startTask = (guildId, userId, now = Date.now()) => beginShift(guildId, userId, 'task', now);
const startOrder = (guildId, userId, orderIdx, now = Date.now()) => beginShift(guildId, userId, 'order', now, orderIdx);

// Wypłata zmiany: monety, licznik zmian w pracy (staż) i zamknięcie wpisu w jednej transakcji
async function settle(c, guildId, userId, shiftRow, pay, now) {
  const isOrder = shiftRow.job_id.startsWith('zlec_'); // zlecenie: bez kariery i stopni
  const balance = await db.applyCredit(c, guildId, userId, pay, isOrder ? 'work_order' : `work_${shiftRow.job_id}`, true);
  if (isOrder) {
    await c.query("UPDATE work_shifts SET status = 'done', earned = $2::bigint, closed_at = $3::bigint WHERE id = $1", [shiftRow.id, pay, now]);
    return { balance, shifts: null, rankUp: null, order: true };
  }
  const before = Number(
    (await c.query('SELECT shifts FROM work_career WHERE guild_id = $1 AND user_id = $2 AND job_id = $3', [guildId, userId, shiftRow.job_id])).rows[0]?.shifts ?? 0,
  );
  await c.query(
    `INSERT INTO work_career (guild_id, user_id, job_id, shifts) VALUES ($1, $2, $3, 1)
     ON CONFLICT (guild_id, user_id, job_id) DO UPDATE SET shifts = work_career.shifts + 1`,
    [guildId, userId, shiftRow.job_id],
  );
  await c.query("UPDATE work_shifts SET status = 'done', earned = $2::bigint, closed_at = $3::bigint WHERE id = $1", [shiftRow.id, pay, now]);
  const promo = (await permLevels(c, guildId, userId)).dyplom;
  const rankBefore = jobs.rankIndex(before, promo);
  const rankAfter = jobs.rankIndex(before + 1, promo);
  return {
    balance,
    shifts: before + 1,
    rankUp: rankAfter > rankBefore ? { from: jobs.JOBS[shiftRow.job_id].ranks[rankBefore], to: jobs.JOBS[shiftRow.job_id].ranks[rankAfter] } : null,
  };
}

// Dodaje XP serwerowe (to samo, co XP z czatu: poziomy, role za poziomy, ogłoszenia). Poza transakcją monet.
async function grantXp(client, guildId, userId, amount) {
  try {
    const { oldLevel, newLevel } = await db.addXp(guildId, userId, amount, 'work', levelForXp);
    if (client && newLevel > oldLevel) {
      await syncLevelRole(client, guildId, userId, newLevel).catch(() => null);
      await announceIfMilestone(client, guildId, userId, oldLevel, newLevel).catch(() => null);
    }
    return { oldLevel, newLevel };
  } catch (err) {
    console.error('Praca: nie udało się dodać XP:', err.message);
    return null;
  }
}

// Odbiór zmiany czasowej. reason: none | not_yet (+endsAt)
async function collectTimed(guildId, userId, now = Date.now(), client = null) {
  const res = await db.withTransaction(async (c) => {
    await loadProfile(c, guildId, userId, now);
    const found = await c.query("SELECT * FROM work_shifts WHERE guild_id = $1 AND user_id = $2 AND status = 'active' AND mode = 'timed' FOR UPDATE", [guildId, userId]);
    const s = found.rows[0];
    if (!s) return { ok: false, reason: 'none' };
    if (Number(s.ends_at) > now) return { ok: false, reason: 'not_yet', endsAt: Number(s.ends_at) };
    const pay = Number(s.pay);
    const out = await settle(c, guildId, userId, s, pay, now);
    return { ok: true, jobId: s.job_id, pay, xp: s.xp, mode: 'timed', ...out };
  });
  if (res.ok) res.level = await grantXp(client, guildId, userId, res.xp);
  return res;
}

// Koniec zadania (mini-gry): hits = liczba poprawnych rund (0-3). reason: gone (już rozliczone / przerwane)
async function finishTask(guildId, userId, shiftId, hits, now = Date.now(), client = null) {
  const res = await db.withTransaction(async (c) => {
    await loadProfile(c, guildId, userId, now);
    const found = await c.query("SELECT * FROM work_shifts WHERE id = $1 AND guild_id = $2 AND user_id = $3 AND status = 'active' AND mode = 'task' FOR UPDATE", [shiftId, guildId, userId]);
    const s = found.rows[0];
    if (!s) return { ok: false, reason: 'gone' };
    const rounds = Number(s.rounds) || jobs.ROUNDS;
    const h = Math.max(0, Math.min(rounds, Math.floor(Number(hits) || 0)));
    const mult = jobs.taskMult(h, rounds);
    const pay = Math.max(1, Math.round(Number(s.pay) * mult));
    const out = await settle(c, guildId, userId, s, pay, now);
    return { ok: true, jobId: s.job_id.startsWith('zlec_') ? null : s.job_id, themeId: s.job_id.startsWith('zlec_') ? s.job_id.slice(5) : null, pay, xp: s.xp, mode: 'task', hits: h, rounds, mult, ...out };
  });
  if (res.ok) res.level = await grantXp(client, guildId, userId, res.xp);
  return res;
}

// Rezygnacja z zadania w trakcie (np. przycisk "Przerwij"): energia przepada, bez wypłaty
async function abandonTask(guildId, userId, shiftId, now = Date.now()) {
  const res = await db.raw.query(
    "UPDATE work_shifts SET status = 'abandoned', closed_at = $4::bigint WHERE id = $1 AND guild_id = $2 AND user_id = $3 AND status = 'active' AND mode = 'task'",
    [shiftId, guildId, userId, now],
  );
  return res.rowCount > 0;
}

// ---------------- PRZEDMIOTY PRACY ----------------
// Efekt przedmiotu w ramach transakcji użycia (przedmiot jest już zabrany; przy odmowie transakcja się cofa).
// use: { type: 'work_energy', amount } | { type: 'work_reset' } | { type: 'work_boost', pay?, xp? }
// Zwraca { ok: true, lines: [...] } albo { ok: false, message }.
async function applyItemEffect(c, guildId, userId, use, now = Date.now()) {
  const { row } = await loadProfile(c, guildId, userId, now);
  if (use.type === 'work_energy') {
    if (row.energy >= row.max_energy) return { ok: false, message: `Masz już pełną energię (${row.energy}/${row.max_energy}).` };
    const amount = Math.round(use.amount * (1 + (row.gear.powerbank * jobs.BATTERY_PER_LEVEL) / 100));
    const after = Math.min(row.max_energy, row.energy + amount);
    await c.query('UPDATE work_profiles SET energy = $3, energy_at = $4::bigint WHERE guild_id = $1 AND user_id = $2', [guildId, userId, after, after >= row.max_energy ? now : row.energy_at]);
    return { ok: true, lines: [`⚡ Energia: **${row.energy}** → **${after}** / ${row.max_energy}${amount !== use.amount ? ` (z Powerbankiem +${amount})` : ''}`] };
  }
  if (use.type === 'work_reset') {
    if (Number(row.task_ready_at) <= now) return { ok: false, message: 'Nie masz teraz przerwy między zadaniami.' };
    await c.query('UPDATE work_profiles SET task_ready_at = 0 WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
    return { ok: true, lines: ['🎮 Przerwa skończona: możesz od razu zacząć kolejne zadanie lub zlecenie.'] };
  }
  if (use.type === 'work_boost') {
    const col = use.pay ? 'boost_pay' : 'boost_xp';
    if (row[col] > 0) return { ok: false, message: `Masz już aktywny taki bonus (+${row[col]}%). Wykorzystaj go najpierw w pracy.` };
    const amount = use.pay ?? use.xp;
    await c.query(`UPDATE work_profiles SET ${col} = $3 WHERE guild_id = $1 AND user_id = $2`, [guildId, userId, amount]);
    return { ok: true, lines: [use.pay ? `💵 Następna zmiana, zadanie albo zlecenie da **+${amount}% monet**.` : `🎓 Następna zmiana, zadanie albo zlecenie da **+${amount}% XP**.`] };
  }
  return { ok: false, message: 'Tego przedmiotu nie da się użyć w pracy.' };
}

module.exports = {
  applyItemEffect,
  startOrder,
  ensureSchema,
  dayKey,
  getState,
  takeJob,
  quitJob,
  claimBenefit,
  startTimed,
  startTask,
  collectTimed,
  finishTask,
  abandonTask,
  grantXp,
  TASK_STALE_MS,
};
