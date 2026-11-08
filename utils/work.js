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
  return { row, today };
}

async function readState(c, guildId, userId, now) {
  const { row, today } = await loadProfile(c, guildId, userId, now);
  // Jedno połączenie w transakcji obsługuje zapytania po kolei (równoległe na tym samym kliencie są przestarzałe w pg)
  const lvl = await c.query('SELECT level FROM user_levels WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
  const career = await c.query('SELECT job_id, shifts FROM work_career WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
  const shift = await c.query("SELECT * FROM work_shifts WHERE guild_id = $1 AND user_id = $2 AND status = 'active'", [guildId, userId]);
  const careerMap = Object.fromEntries(career.rows.map((r) => [r.job_id, Number(r.shifts)]));
  const s = shift.rows[0];
  return {
    today,
    jobId: row.job_id,
    level: Number(lvl.rows[0]?.level ?? 0),
    energyMax: jobs.ENERGY_MAX,
    energyUsed: row.energy_used,
    energyLeft: Math.max(0, jobs.ENERGY_MAX - row.energy_used),
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
// Wspólne sprawdzenia przed startem zmiany czasowej lub zadania
function startChecks(st) {
  if (!st.jobId) return { ok: false, reason: 'no_job' };
  if (st.activeShift) return { ok: false, reason: 'shift_active' };
  if (st.benefitTaken) return { ok: false, reason: 'benefit' };
  const cost = jobs.JOBS[st.jobId].energy;
  if (st.energyLeft < cost) return { ok: false, reason: 'energy', need: cost, left: st.energyLeft };
  return { ok: true, cost };
}

async function beginShift(guildId, userId, mode, now) {
  return db.withTransaction(async (c) => {
    const st = await readState(c, guildId, userId, now);
    const chk = startChecks(st);
    if (!chk.ok) return chk;
    const job = jobs.JOBS[st.jobId];
    const shifts = st.career[job.id] ?? 0;
    const pay = jobs.payFor(job.id, shifts); // wypłata na obecnym stopniu (zadanie mnoży ją potem przez wynik)
    const xp = jobs.xpFor(job.id, mode === 'task');
    const endsAt = mode === 'timed' ? now + job.minutes * 60_000 : null;
    await c.query('UPDATE work_profiles SET energy_used = energy_used + $3, worked_day = $4 WHERE guild_id = $1 AND user_id = $2', [guildId, userId, chk.cost, st.today]);
    const ins = await c.query(
      `INSERT INTO work_shifts (guild_id, user_id, job_id, mode, started_at, ends_at, pay, xp)
       VALUES ($1, $2, $3, $4, $5::bigint, $6::bigint, $7::bigint, $8) RETURNING id`,
      [guildId, userId, job.id, mode, now, endsAt, pay, xp],
    );
    return { ok: true, shiftId: Number(ins.rows[0].id), jobId: job.id, cost: chk.cost, pay, xp, endsAt, energyLeft: st.energyLeft - chk.cost };
  });
}

// reason: no_job | shift_active | benefit | energy (+need, left)
const startTimed = (guildId, userId, now = Date.now()) => beginShift(guildId, userId, 'timed', now);
const startTask = (guildId, userId, now = Date.now()) => beginShift(guildId, userId, 'task', now);

// Wypłata zmiany: monety, licznik zmian w pracy (staż) i zamknięcie wpisu w jednej transakcji
async function settle(c, guildId, userId, shiftRow, pay, now) {
  const balance = await db.applyCredit(c, guildId, userId, pay, `work_${shiftRow.job_id}`, true);
  const before = Number(
    (await c.query('SELECT shifts FROM work_career WHERE guild_id = $1 AND user_id = $2 AND job_id = $3', [guildId, userId, shiftRow.job_id])).rows[0]?.shifts ?? 0,
  );
  await c.query(
    `INSERT INTO work_career (guild_id, user_id, job_id, shifts) VALUES ($1, $2, $3, 1)
     ON CONFLICT (guild_id, user_id, job_id) DO UPDATE SET shifts = work_career.shifts + 1`,
    [guildId, userId, shiftRow.job_id],
  );
  await c.query("UPDATE work_shifts SET status = 'done', earned = $2::bigint, closed_at = $3::bigint WHERE id = $1", [shiftRow.id, pay, now]);
  const rankBefore = jobs.rankIndex(before);
  const rankAfter = jobs.rankIndex(before + 1);
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
    const h = Math.max(0, Math.min(jobs.ROUNDS, Math.floor(Number(hits) || 0)));
    const mult = jobs.taskMult(h);
    const pay = Math.max(1, Math.round(Number(s.pay) * mult));
    const out = await settle(c, guildId, userId, s, pay, now);
    return { ok: true, jobId: s.job_id, pay, xp: s.xp, mode: 'task', hits: h, mult, ...out };
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

module.exports = {
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
