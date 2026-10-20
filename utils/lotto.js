const { randomInt } = require('node:crypto');
const { EmbedBuilder } = require('discord.js');
const { formatCoins } = require('./economy');

// ============================================================
//  LOTTO BOBA - konfiguracja (zmieniasz tutaj albo w .env)
// ============================================================
const PRICE = Number(process.env.LOTTO_TICKET_PRICE ?? 100); // cena jednego losu
const MAX_TICKETS = Number(process.env.LOTTO_MAX_TICKETS ?? 5); // ile losów na osobę na jedno losowanie
const PICK = Number(process.env.LOTTO_PICK ?? 4); // ile liczb wybiera gracz
const RANGE = Number(process.env.LOTTO_RANGE ?? 12); // z ilu liczb (1..RANGE); max 25 (limit menu Discorda)
const DRAW_HOUR = Number(process.env.LOTTO_DRAW_HOUR ?? 20); // godzina losowania (czas polski)

// Drobne nagrody (wielokrotność ceny losu), płacone Z PULI:
//  - trafione PICK-2 liczb -> zwrot ceny losu
//  - trafione PICK-1 liczb -> trzykrotność ceny losu
//  - trafione WSZYSTKIE liczby -> cała pula (kumulacja), dzielona między zwycięzców
const PRIZE_MULTIPLIERS = { [PICK - 2]: 1, [PICK - 1]: 3 };
// Drobne nagrody łącznie nie mogą zjeść więcej niż ta część puli, żeby kumulacja nigdy nie była pusta.
// Gdyby w danym losowaniu przekroczyły limit, są proporcjonalnie zmniejszane (rzadkie, głównie na starcie).
const SMALL_PRIZE_CAP = 0.75;

if (PICK < 3 || PICK >= RANGE || RANGE > 25) {
  throw new Error('Lotto: ustaw LOTTO_PICK >= 3, LOTTO_PICK < LOTTO_RANGE oraz LOTTO_RANGE <= 25');
}

const prizeFor = (matches) => (PRIZE_MULTIPLIERS[matches] ?? 0) * PRICE;

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

async function setAnnounceChannel(guildId, channelId) {
  await ensureSchema();
  await getPool().query(`
    INSERT INTO lotto_state (guild_id, pool, channel_id) VALUES ($1, 0, $2)
    ON CONFLICT (guild_id) DO UPDATE SET channel_id = EXCLUDED.channel_id
  `, [guildId, channelId]);
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

    const poolBefore = Number(state.pool);

    if (tickets.length === 0) {
      await c.query('UPDATE lotto_state SET last_draw_date = $2 WHERE guild_id = $1', [guildId, todayDate]);
      return { skipped: true, drawDate: todayDate, poolBefore, poolAfter: poolBefore };
    }

    const drawn = forcedNumbers ?? pickDistinct();

    // 1) kto ile trafił
    const graded = tickets.map((t) => {
      const mine = parseNumbers(t.numbers);
      return { id: Number(t.id), userId: t.user_id, numbers: mine, matches: countMatches(mine, drawn) };
    });
    const jackpotTickets = graded.filter((t) => t.matches === PICK);

    // 2) drobne nagrody z puli (z limitem, żeby nie opróżnić kumulacji)
    const smallWanted = graded.reduce((sum, t) => sum + (t.matches < PICK ? prizeFor(t.matches) : 0), 0);
    const smallBudget = Math.floor(poolBefore * SMALL_PRIZE_CAP);
    const scale = smallWanted > smallBudget ? smallBudget / smallWanted : 1;
    let smallPaid = 0;
    for (const t of graded) {
      t.prize = t.matches < PICK ? Math.floor(prizeFor(t.matches) * scale) : 0;
      smallPaid += t.prize;
    }

    // 3) kumulacja: wszystko, co zostało w puli, dzielone po równo między zwycięskie losy
    const remaining = poolBefore - smallPaid;
    const jackpotEach = jackpotTickets.length > 0 ? Math.floor(remaining / jackpotTickets.length) : 0;
    for (const t of jackpotTickets) t.prize = jackpotEach;
    const poolAfter = jackpotTickets.length > 0 ? remaining - jackpotEach * jackpotTickets.length : remaining;

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
      `, [guildId, userId, amount, Number(res.rows[0].balance), nowMs]);
    }

    // 5) zamknięcie losów, historia i nowy stan puli
    for (const t of graded) {
      await c.query(
        `UPDATE lotto_tickets SET status = 'drawn', matches = $2, prize = $3::bigint WHERE id = $1`,
        [t.id, t.matches, t.prize],
      );
    }
    await c.query('UPDATE lotto_state SET pool = $2::bigint, last_draw_date = $3 WHERE guild_id = $1', [guildId, poolAfter, todayDate]);
    await c.query(`
      INSERT INTO lotto_draws (guild_id, draw_date, numbers, tickets, pool_before, small_paid, jackpot_winners, jackpot_each, pool_after, drawn_at)
      VALUES ($1, $2, $3, $4, $5::bigint, $6::bigint, $7, $8::bigint, $9::bigint, $10::bigint)
    `, [guildId, todayDate, drawn.join(','), tickets.length, poolBefore, smallPaid, jackpotTickets.length, jackpotEach, poolAfter, nowMs]);

    const tiers = {};
    for (const t of graded) if (t.matches < PICK && t.prize > 0) tiers[t.matches] = (tiers[t.matches] ?? 0) + 1;

    return {
      skipped: false,
      drawDate: todayDate,
      numbers: drawn,
      ticketCount: tickets.length,
      poolBefore,
      smallPaid,
      scaled: scale < 1,
      tiers,
      jackpotWinners: jackpotTickets.map((t) => t.userId),
      jackpotEach,
      poolAfter,
      totalByUser,
    };
  });
}

// ============================================================
//  OGŁOSZENIE WYNIKÓW + HARMONOGRAM
// ============================================================
function buildAnnouncement(summary) {
  const jackpotHit = summary.jackpotWinners.length > 0;
  const uniqueWinners = [...new Set(summary.jackpotWinners)];

  const lines = [
    `# 🎱 ${formatNumbers(summary.numbers)}`,
    `Sprzedanych losów: **${summary.ticketCount}**`,
    '',
  ];

  if (jackpotHit) {
    lines.push(
      `💰 **KUMULACJA TRAFIONA!** Pulę ${formatCoins(summary.poolBefore - summary.smallPaid)} zgarnia:`,
      ...uniqueWinners.map((id) => {
        const n = summary.jackpotWinners.filter((w) => w === id).length;
        return `• <@${id}> — ${formatCoins(summary.jackpotEach * n)}`;
      }),
    );
  } else {
    lines.push(`😮‍💨 Nikt nie trafił wszystkich liczb. Pula przechodzi na następne losowanie!`);
  }

  const tierLines = Object.keys(summary.tiers)
    .map(Number)
    .sort((a, b) => b - a)
    .map((m) => `• trafione **${m}**: ${summary.tiers[m]} ${summary.tiers[m] === 1 ? 'los' : 'losów'} po ${formatCoins(prizeFor(m))}${summary.scaled ? ' (zmniejszone, bo pula była mała)' : ''}`);
  if (tierLines.length > 0) lines.push('', '**Drobne nagrody:**', ...tierLines);

  lines.push('', `🎟️ **Kumulacja na następne losowanie: ${formatCoins(summary.poolAfter)}**`);

  return new EmbedBuilder()
    .setColor(jackpotHit ? 0xf1c40f : 0x3498db)
    .setTitle(jackpotHit ? '🎉 Lotto Boba: JACKPOT!' : '🎱 Lotto Boba: wyniki losowania')
    .setDescription(lines.join('\n'))
    .setFooter({ text: `Losowanie z dnia ${summary.drawDate}. Nowe losy: /lotto` })
    .setTimestamp();
}

async function announce(client, guildId, summary) {
  const row = (await getPool().query('SELECT channel_id FROM lotto_state WHERE guild_id = $1', [guildId])).rows[0];
  if (!row?.channel_id) return false;

  const channel = await client.channels.fetch(row.channel_id).catch(() => null);
  if (!channel?.isTextBased?.()) return false;

  const winners = [...new Set(summary.jackpotWinners)];
  const sent = await channel
    .send({
      content: winners.length > 0 ? `🎉 ${winners.map((id) => `<@${id}>`).join(' ')}` : undefined,
      embeds: [buildAnnouncement(summary)],
      allowedMentions: { users: winners },
    })
    .catch((err) => {
      console.error('Lotto: nie wysłano ogłoszenia:', err.message);
      return null;
    });
  return Boolean(sent);
}

// Jeden obieg: jeśli jest już po godzinie losowania, rozlicza wszystkie serwery z otwartymi losami.
// Wywoływane co minutę oraz od razu po starcie bota (nadrabia losowanie, jeśli bot był wyłączony).
let tickRunning = false;
async function tick(client, nowMs = Date.now()) {
  if (tickRunning) return [];
  tickRunning = true;
  const results = [];
  try {
    const { date, hour } = warsawParts(nowMs);
    if (hour < DRAW_HOUR) return results;

    await ensureSchema();
    const guilds = (await getPool().query(
      `SELECT DISTINCT guild_id FROM lotto_tickets WHERE status = 'open' AND draw_date <= $1`,
      [date],
    )).rows;

    for (const { guild_id: guildId } of guilds) {
      try {
        const summary = await runDraw(guildId, date, nowMs);
        if (!summary) continue;
        results.push({ guildId, summary });
        if (!summary.skipped) await announce(client, guildId, summary);
      } catch (err) {
        console.error(`Lotto: błąd losowania na ${guildId}:`, err);
      }
    }
  } catch (err) {
    console.error('Lotto: błąd harmonogramu:', err);
  } finally {
    tickRunning = false;
  }
  return results;
}

function startScheduler(client) {
  const run = () => tick(client).catch((err) => console.error('Lotto: błąd obiegu:', err));
  run(); // nadrobienie po restarcie
  const timer = setInterval(run, 60_000);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`🎱 Lotto: harmonogram uruchomiony (losowanie codziennie o ${DRAW_HOUR}:00, czas polski).`);
}

module.exports = {
  PRICE,
  MAX_TICKETS,
  PICK,
  RANGE,
  DRAW_HOUR,
  SMALL_PRIZE_CAP,
  PRIZE_MULTIPLIERS,
  prizeFor,
  warsawParts,
  addDays,
  drawTimestamp,
  nextDrawDate,
  pickDistinct,
  normalizeNumbers,
  formatNumbers,
  countMatches,
  ensureSchema,
  getStatus,
  setAnnounceChannel,
  buyTicket,
  runDraw,
  buildAnnouncement,
  tick,
  startScheduler,
};
