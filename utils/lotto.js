const { randomInt } = require('node:crypto');
const {
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
} = require('discord.js');
const { formatCoins } = require('./economy');

// ============================================================
//  LOTTO BOBA - konfiguracja (zmieniasz tutaj albo w .env)
// ============================================================
const PRICE = Number(process.env.LOTTO_TICKET_PRICE ?? 100); // cena jednego losu
const MAX_TICKETS = Number(process.env.LOTTO_MAX_TICKETS ?? 5); // ile losów na osobę na jedno losowanie
const PICK = Number(process.env.LOTTO_PICK ?? 3); // ile liczb wybiera gracz
const RANGE = Number(process.env.LOTTO_RANGE ?? 12); // z ilu liczb (1..RANGE); 25 = max jednej listy w Discordzie
const DRAW_HOUR = Number(process.env.LOTTO_DRAW_HOUR ?? 20); // godzina losowania (czas polski)

// Kumulacja: startowa kwota jest LOSOWANA (zawsze wielokrotność ROUND_STEP) na starcie i po każdej wygranej,
// a po każdym losowaniu pula jest zaokrąglana W GÓRĘ do pełnych ROUND_STEP (np. 12 854 -> 13 000).
// Te monety dorzuca "Bob" (powstają z niczego), a ich sumę zapisujemy w lotto_state.house_total.
const ROUND_STEP = Number(process.env.LOTTO_ROUND ?? 500);
const SEED_MIN = Number(process.env.LOTTO_SEED_MIN ?? 500);
const SEED_MAX = Number(process.env.LOTTO_SEED_MAX ?? 3000);

// Drobne nagrody (wielokrotność ceny losu), płacone Z PULI:
//  - trafione PICK-2 liczb -> połowa ceny losu (domyślnie x0,5)
//  - trafione PICK-1 liczb -> trzykrotność ceny losu (domyślnie x3)
//  - trafione WSZYSTKIE liczby -> cała pula (kumulacja), dzielona między zwycięzców
// Przy domyślnych 3 z 12 drobne nagrody zwracają graczom ok. 61% ceny losu, a reszta wpada do kumulacji,
// która trafia się średnio raz na 220 losów.
const PRIZE_NEAR = Number(process.env.LOTTO_PRIZE_NEAR ?? 3);
const PRIZE_MINOR = Number(process.env.LOTTO_PRIZE_MINOR ?? 0.5);
const PRIZE_MULTIPLIERS = { [PICK - 2]: PRIZE_MINOR, [PICK - 1]: PRIZE_NEAR };
// Drobne nagrody łącznie nie mogą zjeść więcej niż ta część puli, żeby kumulacja nigdy nie była pusta.
// Gdyby w danym losowaniu przekroczyły limit, są proporcjonalnie zmniejszane (rzadkie, głównie na starcie).
const SMALL_PRIZE_CAP = 0.75;

if (PICK < 3 || PICK >= RANGE || RANGE > 50) {
  throw new Error('Lotto: ustaw LOTTO_PICK >= 3, LOTTO_PICK < LOTTO_RANGE oraz LOTTO_RANGE <= 50');
}
if (ROUND_STEP < 1 || SEED_MIN > SEED_MAX || SEED_MIN % ROUND_STEP !== 0 || SEED_MAX % ROUND_STEP !== 0) {
  throw new Error('Lotto: LOTTO_SEED_MIN i LOTTO_SEED_MAX muszą być wielokrotnościami LOTTO_ROUND i SEED_MIN <= SEED_MAX');
}

const prizeFor = (matches) => Math.round((PRIZE_MULTIPLIERS[matches] ?? 0) * PRICE);

// Dokładne szanse (rozkład hipergeometryczny): ile jest układów z dokładnie m trafieniami
const choose = (n, k) => {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
};
const COMBINATIONS = choose(RANGE, PICK);
const oddsFor = (matches) => (choose(PICK, matches) * choose(RANGE - PICK, PICK - matches)) / COMBINATIONS;
// Szansa na jakąkolwiek nagrodę (przynajmniej PICK-2 trafień z nagrodą > 0)
const anyPrizeOdds = () => {
  let p = 0;
  for (let m = 0; m <= PICK; m++) if (m === PICK || prizeFor(m) > 0) p += oddsFor(m);
  return p;
};

// Zaokrąglenie w górę do pełnych ROUND_STEP (12 854 -> 13 000, 13 000 -> 13 000)
const roundUp = (n) => Math.ceil(n / ROUND_STEP) * ROUND_STEP;
// Losowa startowa kumulacja: wielokrotność ROUND_STEP z przedziału [SEED_MIN, SEED_MAX]
const randomSeed = () => SEED_MIN + ROUND_STEP * randomInt(0, (SEED_MAX - SEED_MIN) / ROUND_STEP + 1);

// ============================================================
//  CZAS (Europe/Warsaw) - bez zależności od strefy serwera hostującego
// ============================================================
const WARSAW = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Warsaw',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
});

function warsawParts(ms) {
  const p = Object.fromEntries(WARSAW.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Moment losowania (ms UTC) dla danej daty kalendarzowej (czas polski)
function drawTimestamp(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  for (const offsetH of [2, 1]) {
    const t = Date.UTC(y, m - 1, d, DRAW_HOUR) - offsetH * 3600_000;
    const p = warsawParts(t);
    if (p.date === dateStr && p.hour === DRAW_HOUR) return t;
  }
  return Date.UTC(y, m - 1, d, DRAW_HOUR) - 3600_000;
}

// Na które losowanie trafi los kupiony teraz: dzisiejsze (jeśli jeszcze przed godziną losowania) albo jutrzejsze.
function nextDrawDate(lastDrawDate, nowMs = Date.now()) {
  const { date, hour } = warsawParts(nowMs);
  let target = hour < DRAW_HOUR ? date : addDays(date, 1);
  if (lastDrawDate && target <= lastDrawDate) target = addDays(lastDrawDate, 1);
  return target;
}

// ============================================================
//  LICZBY
// ============================================================
function pickDistinct(count = PICK, range = RANGE) {
  const pool = Array.from({ length: range }, (_, i) => i + 1);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count).sort((a, b) => a - b);
}

// Zwraca posortowaną tablicę albo null, gdy wybór jest nieprawidłowy
function normalizeNumbers(numbers) {
  if (!Array.isArray(numbers)) return null;
  const nums = numbers.map(Number);
  if (nums.length !== PICK) return null;
  if (!nums.every((n) => Number.isInteger(n) && n >= 1 && n <= RANGE)) return null;
  if (new Set(nums).size !== PICK) return null;
  return nums.sort((a, b) => a - b);
}

const formatNumbers = (nums) => nums.map((n) => String(n).padStart(2, '0')).join(' · ');
const parseNumbers = (text) => text.split(',').map(Number);
const countMatches = (mine, drawn) => mine.filter((n) => drawn.includes(n)).length;

// ============================================================
//  BAZA
// ============================================================
const getPool = () => require('../db').raw; // wczytywane tutaj, żeby logikę dało się testować bez prawdziwej bazy

let schemaPromise = null;
function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = getPool()
      .query(`
        CREATE TABLE IF NOT EXISTS lotto_state (
          guild_id TEXT PRIMARY KEY,
          pool BIGINT NOT NULL DEFAULT 0 CHECK (pool >= 0),
          last_draw_date TEXT,
          channel_id TEXT
        );
        CREATE TABLE IF NOT EXISTS lotto_tickets (
          id BIGSERIAL PRIMARY KEY,
          guild_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          numbers TEXT NOT NULL,
          draw_date TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open',
          matches INT,
          prize BIGINT,
          created_at BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_lotto_tickets_open ON lotto_tickets(guild_id, status, draw_date);
        CREATE INDEX IF NOT EXISTS idx_lotto_tickets_user ON lotto_tickets(guild_id, user_id, status);
        CREATE TABLE IF NOT EXISTS lotto_draws (
          id BIGSERIAL PRIMARY KEY,
          guild_id TEXT NOT NULL,
          draw_date TEXT NOT NULL,
          numbers TEXT NOT NULL,
          tickets INT NOT NULL,
          pool_before BIGINT NOT NULL,
          small_paid BIGINT NOT NULL,
          jackpot_winners INT NOT NULL,
          jackpot_each BIGINT NOT NULL,
          pool_after BIGINT NOT NULL,
          drawn_at BIGINT NOT NULL
        );
      `)
      // Nowe kolumny dodajemy bezpiecznie, żeby aktualizacja ze starszej wersji nie kasowała danych.
      // seeded: czy kumulacja dostała już losową kwotę startową. house_total: ile monet łącznie dorzucił Bob.
      .then(() => getPool().query(`
        ALTER TABLE lotto_state
          ADD COLUMN IF NOT EXISTS seeded BOOLEAN NOT NULL DEFAULT false,
          ADD COLUMN IF NOT EXISTS house_total BIGINT NOT NULL DEFAULT 0;
        ALTER TABLE lotto_draws
          ADD COLUMN IF NOT EXISTS house_added BIGINT NOT NULL DEFAULT 0;
      `))
      .catch((err) => {
        schemaPromise = null; // pozwól spróbować ponownie
        throw err;
      });
  }
  return schemaPromise;
}

async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    throw err;
  } finally {
    client.release();
  }
}

// ---------------- STATUS (dla menu) ----------------
async function getStatus(guildId, userId, nowMs = Date.now()) {
  await ensureSchema();
  const pool = getPool();
  const state = (await pool.query('SELECT * FROM lotto_state WHERE guild_id = $1', [guildId])).rows[0];
  const tickets = (await pool.query(
    `SELECT id, numbers, draw_date FROM lotto_tickets WHERE guild_id = $1 AND user_id = $2 AND status = 'open' ORDER BY id`,
    [guildId, userId],
  )).rows;
  const account = (await pool.query('SELECT balance FROM economy_accounts WHERE guild_id = $1 AND user_id = $2', [guildId, userId])).rows[0];
  const drawDate = nextDrawDate(state?.last_draw_date, nowMs);

  return {
    pool: state ? Number(state.pool) : 0,
    drawDate,
    drawAt: drawTimestamp(drawDate),
    channelId: state?.channel_id ?? null,
    tickets: tickets.map((t) => ({ id: Number(t.id), numbers: parseNumbers(t.numbers) })),
    balance: account ? Number(account.balance) : 0,
  };
}

// Nadaje kumulacji LOSOWĄ kwotę startową (wielokrotność ROUND_STEP), jeśli jeszcze jej nie ma.
// Do kwoty wpada to, co już jest w puli (np. z testów), zaokrąglone w górę; różnicę dorzuca Bob.
// Wywoływane wewnątrz transakcji na zablokowanym wierszu puli.
async function seedIfNeeded(c, state) {
  if (state.seeded) return { seeded: false, pool: Number(state.pool), added: 0 };
  const before = Number(state.pool);
  const pool = roundUp(before + randomSeed());
  const added = pool - before;
  await c.query(
    'UPDATE lotto_state SET pool = $2::bigint, seeded = true, house_total = house_total + $3::bigint WHERE guild_id = $1',
    [state.guild_id, pool, added],
  );
  return { seeded: true, pool, added };
}

// Ustawia kanał ogłoszeń i (przy pierwszej konfiguracji) losuje startową kumulację.
// Zwraca { seededNow, pool }: seededNow = true, gdy właśnie ruszyła pierwsza kumulacja (warto ją ogłosić).
async function setAnnounceChannel(guildId, channelId) {
  await ensureSchema();
  return tx(async (c) => {
    await c.query('INSERT INTO lotto_state (guild_id, pool) VALUES ($1, 0) ON CONFLICT (guild_id) DO NOTHING', [guildId]);
    const state = (await c.query('SELECT * FROM lotto_state WHERE guild_id = $1 FOR UPDATE', [guildId])).rows[0];
    await c.query('UPDATE lotto_state SET channel_id = $2 WHERE guild_id = $1', [guildId, channelId]);
    const seed = await seedIfNeeded(c, state);
    return { seededNow: seed.seeded, pool: seed.pool };
  });
}

// ---------------- ZAKUP LOSU ----------------
// Wszystko w jednej transakcji: sprawdzenie limitu, pobranie monet, zapis losu, dopisanie do puli i wpis w dzienniku.
// Zablokowany wiersz puli (FOR UPDATE) ustawia zakupy i losowanie w kolejce, więc limit 5 losów nie da się obejść
// szybkim klikaniem, a los kupiony w trakcie losowania trafia zawsze do jednego, właściwego losowania.
// Zwraca { ok: true, ... } albo { ok: false, reason: 'invalid' | 'limit' | 'funds' }.
async function buyTicket(guildId, userId, numbers, nowMs = Date.now()) {
  const nums = normalizeNumbers(numbers);
  if (!nums) return { ok: false, reason: 'invalid' };
  await ensureSchema();

  return tx(async (c) => {
    await c.query('INSERT INTO lotto_state (guild_id, pool) VALUES ($1, 0) ON CONFLICT (guild_id) DO NOTHING', [guildId]);
    const state = (await c.query('SELECT * FROM lotto_state WHERE guild_id = $1 FOR UPDATE', [guildId])).rows[0];
    const drawDate = nextDrawDate(state.last_draw_date, nowMs);

    const owned = (await c.query(
      `SELECT COUNT(*)::int AS n FROM lotto_tickets WHERE guild_id = $1 AND user_id = $2 AND status = 'open'`,
      [guildId, userId],
    )).rows[0].n;
    if (owned >= MAX_TICKETS) return { ok: false, reason: 'limit', owned };

    const paid = await c.query(`
      UPDATE economy_accounts SET balance = balance - $3::bigint
      WHERE guild_id = $1 AND user_id = $2 AND balance >= $3::bigint
      RETURNING balance
    `, [guildId, userId, PRICE]);
    if (paid.rowCount === 0) return { ok: false, reason: 'funds' };
    const balance = Number(paid.rows[0].balance);

    const ticket = (await c.query(`
      INSERT INTO lotto_tickets (guild_id, user_id, numbers, draw_date, status, created_at)
      VALUES ($1, $2, $3, $4, 'open', $5::bigint) RETURNING id
    `, [guildId, userId, nums.join(','), drawDate, nowMs])).rows[0];

    // Jeśli nikt jeszcze nie uruchomił kumulacji (np. brak /setup-lotto), pierwszy zakup losuje jej kwotę startową.
    await seedIfNeeded(c, state);

    const pool = Number((await c.query(
      'UPDATE lotto_state SET pool = pool + $2::bigint WHERE guild_id = $1 RETURNING pool',
      [guildId, PRICE],
    )).rows[0].pool);

    await c.query(`
      INSERT INTO economy_transactions (guild_id, user_id, amount, balance_after, reason, created_at)
      VALUES ($1, $2, $3::bigint, $4::bigint, 'lotto_ticket', $5::bigint)
    `, [guildId, userId, -PRICE, balance, nowMs]);

    return { ok: true, ticketId: Number(ticket.id), numbers: nums, drawDate, balance, pool, owned: owned + 1 };
  });
}

// ---------------- DARMOWE LOSY (z przedmiotów) ----------------
// Działa w TRANSAKCJI przekazanej z zewnątrz (c), żeby zużycie przedmiotu i wydanie losów były atomowe.
// Los jest za darmo, więc NIE dopisuje nic do puli (żeby nie tworzyć monet z niczego). Liczy się do limitu MAX_TICKETS.
// Liczby losuje bot. Zwraca { granted, leftover, tickets, drawDate }: leftover = ile losów nie zmieściło się w limicie.
async function grantFreeTicketsTx(c, guildId, userId, count, nowMs = Date.now()) {
  await c.query('INSERT INTO lotto_state (guild_id, pool) VALUES ($1, 0) ON CONFLICT (guild_id) DO NOTHING', [guildId]);
  const state = (await c.query('SELECT * FROM lotto_state WHERE guild_id = $1 FOR UPDATE', [guildId])).rows[0];
  const drawDate = nextDrawDate(state.last_draw_date, nowMs);

  const owned = (await c.query(
    `SELECT COUNT(*)::int AS n FROM lotto_tickets WHERE guild_id = $1 AND user_id = $2 AND status = 'open'`,
    [guildId, userId],
  )).rows[0].n;

  const granted = Math.max(0, Math.min(count, MAX_TICKETS - owned));
  const tickets = [];
  for (let i = 0; i < granted; i++) {
    const nums = normalizeNumbers(pickDistinct());
    const row = (await c.query(`
      INSERT INTO lotto_tickets (guild_id, user_id, numbers, draw_date, status, created_at)
      VALUES ($1, $2, $3, $4, 'open', $5::bigint) RETURNING id
    `, [guildId, userId, nums.join(','), drawDate, nowMs])).rows[0];
    tickets.push({ id: Number(row.id), numbers: nums });
  }
  if (granted > 0) await seedIfNeeded(c, state);
  return { granted, leftover: count - granted, tickets, drawDate };
}

// ---------------- LOSOWANIE ----------------
// Dla jednego serwera, w jednej transakcji: losuje liczby, rozlicza WSZYSTKIE otwarte losy
// (z datą losowania <= today), wypłaca nagrody z puli i zostawia resztę jako kumulację.
// Zwraca null, jeśli dzisiejsze losowanie już się odbyło; { skipped: true }, gdy nie było losów.
async function runDraw(guildId, todayDate, nowMs = Date.now(), forcedNumbers = null) {
  await ensureSchema();

  return tx(async (c) => {
    const state = (await c.query('SELECT * FROM lotto_state WHERE guild_id = $1 FOR UPDATE', [guildId])).rows[0];
    if (!state) return null;
    if (state.last_draw_date && state.last_draw_date >= todayDate) return null;

    const tickets = (await c.query(
      `SELECT id, user_id, numbers FROM lotto_tickets
       WHERE guild_id = $1 AND status = 'open' AND draw_date <= $2 ORDER BY id FOR UPDATE`,
      [guildId, todayDate],
    )).rows;

    // Kumulacja bez kwoty startowej (stara wersja tabel albo brak konfiguracji) dostaje ją tuż przed losowaniem
    const seed = await seedIfNeeded(c, state);
    const poolBefore = seed.seeded ? seed.pool : Number(state.pool);

    if (tickets.length === 0) {
      const rolled = roundUp(poolBefore);
      await c.query(
        'UPDATE lotto_state SET pool = $2::bigint, last_draw_date = $3, house_total = house_total + $4::bigint WHERE guild_id = $1',
        [guildId, rolled, todayDate, rolled - poolBefore],
      );
      return { skipped: true, drawDate: todayDate, poolBefore, poolAfter: rolled, houseAdded: rolled - poolBefore };
    }

    const drawn = forcedNumbers ?? pickDistinct();

    // 1) kto ile trafił
    // Losy ze starych zasad (inna liczba wybranych liczb niż teraz) nie biorą udziału: dostają zwrot ceny losu.
    const graded = tickets.map((t) => {
      const mine = parseNumbers(t.numbers);
      const legacy = mine.length !== PICK || mine.some((n) => n > RANGE);
      return { id: Number(t.id), userId: t.user_id, numbers: mine, legacy, matches: legacy ? 0 : countMatches(mine, drawn) };
    });
    const jackpotTickets = graded.filter((t) => !t.legacy && t.matches === PICK);

    // 2) drobne nagrody z puli (z limitem, żeby nie opróżnić kumulacji)
    let refunds = 0;
    for (const t of graded) if (t.legacy) refunds += PRICE;
    const smallWanted = graded.reduce((sum, t) => sum + (!t.legacy && t.matches < PICK ? prizeFor(t.matches) : 0), 0);
    const smallBudget = Math.max(0, Math.floor((poolBefore - refunds) * SMALL_PRIZE_CAP));
    const scale = smallWanted > smallBudget ? smallBudget / smallWanted : 1;
    let smallPaid = 0;
    for (const t of graded) {
      t.prize = t.legacy ? PRICE : t.matches < PICK ? Math.floor(prizeFor(t.matches) * scale) : 0;
      smallPaid += t.prize;
    }

    // 3) kumulacja: wszystko, co zostało w puli, dzielone po równo między zwycięskie losy
    const remaining = poolBefore - smallPaid;
    const jackpotEach = jackpotTickets.length > 0 ? Math.floor(remaining / jackpotTickets.length) : 0;
    for (const t of jackpotTickets) t.prize = jackpotEach;
    const poolRemaining = jackpotTickets.length > 0 ? remaining - jackpotEach * jackpotTickets.length : remaining;

    // 3b) nowa pula: po wygranej startuje NOWA, losowa kumulacja; bez wygranej reszta przechodzi dalej.
    // W obu przypadkach pula jest zaokrąglana w górę do pełnych ROUND_STEP, a różnicę dorzuca Bob.
    const newCycle = jackpotTickets.length > 0;
    const poolAfter = roundUp(newCycle ? poolRemaining + randomSeed() : poolRemaining);
    const houseAdded = poolAfter - poolRemaining;

    // 4) wypłaty: jedna wpłata i jeden wpis w dzienniku na osobę
    const totalByUser = new Map();
    for (const t of graded) totalByUser.set(t.userId, (totalByUser.get(t.userId) ?? 0) + t.prize);
    for (const [userId, amount] of totalByUser) {
      if (amount <= 0) continue;
      const res = await c.query(`
        INSERT INTO economy_accounts (guild_id, user_id, balance, total_earned, created_at)
        VALUES ($1, $2, $3::bigint, 0, $4::bigint)
        ON CONFLICT (guild_id, user_id) DO UPDATE SET balance = economy_accounts.balance + $3::bigint
        RETURNING balance
      `, [guildId, userId, amount, nowMs]);
      await c.query(`
        INSERT INTO economy_transactions (guild_id, user_id, amount, balance_after, reason, created_at)
        VALUES ($1, $2, $3::bigint, $4::bigint, 'lotto_win', $5::bigint)
      `, [guildId, userId, 
