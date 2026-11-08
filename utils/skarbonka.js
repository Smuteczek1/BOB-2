const db = require('../db');
const inv = require('./inventory');
const items = require('./items');

// ============================================================
//  Skarbonka (stały przedmiot, do 5 poziomów): odsetki od salda.
//  Odsetki = saldo * 0,2% * poziom, nie więcej niż 400 * poziom monet za dzień. Naliczane leniwie przy otwarciu /portfel
//  (raz dziennie; zaległe dni sumują się do 3, żeby nie trzeba było zaglądać codziennie). Zapis w księdze: 'skarbonka'.
// ============================================================

const P = items.PERKS;
let schemaReady = null;

function ensureSchema() {
  schemaReady ??= db.raw
    .query(`CREATE TABLE IF NOT EXISTS piggy_interest (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      last_day TEXT NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    )`)
    .catch((err) => { schemaReady = null; throw err; });
  return schemaReady;
}

const dayKey = (now) => new Date(now).toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

// Odsetki za jeden dzień dla salda i poziomu (czysta matematyka)
const dailyInterest = (balance, level) => Math.max(0, Math.min(Math.floor((balance * P.INTEREST_PCT_PER_LEVEL * level) / 100), P.INTEREST_CAP_PER_LEVEL * level));

// Zwraca { ok: true, amount, days, level, balance } albo { ok: false, reason: 'no_item' | 'already' | 'zero' }
async function collect(guildId, userId, now = Date.now()) {
  await ensureSchema();
  const today = dayKey(now);
  return db.withTransaction(async (c) => {
    const level = await inv.itemLevel(guildId, userId, 'skarbonka', c);
    if (level <= 0) return { ok: false, reason: 'no_item' };

    await c.query('INSERT INTO piggy_interest (guild_id, user_id, last_day) VALUES ($1, $2, $3) ON CONFLICT (guild_id, user_id) DO NOTHING', [guildId, userId, dayKey(now - 86_400_000)]);
    const row = (await c.query('SELECT last_day FROM piggy_interest WHERE guild_id = $1 AND user_id = $2 FOR UPDATE', [guildId, userId])).rows[0];
    const days = Math.min(P.INTEREST_MAX_DAYS, dayDiff(row.last_day, today));
    if (days <= 0) return { ok: false, reason: 'already' };

    const acc = await c.query('SELECT balance FROM economy_accounts WHERE guild_id = $1 AND user_id = $2 FOR UPDATE', [guildId, userId]);
    const balance = Number(acc.rows[0]?.balance ?? 0);
    const amount = dailyInterest(balance, level) * days;
    await c.query('UPDATE piggy_interest SET last_day = $3 WHERE guild_id = $1 AND user_id = $2', [guildId, userId, today]);
    if (amount <= 0) return { ok: false, reason: 'zero' };
    const newBalance = await db.applyCredit(c, guildId, userId, amount, 'skarbonka', true);
    return { ok: true, amount, days, level, balance: newBalance };
  });
}

module.exports = { collect, dailyInterest, ensureSchema, dayKey };
