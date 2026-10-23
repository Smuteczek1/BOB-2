const db = require('../db');
const items = require('./items');

// Rzucany, gdy akcja jest niedozwolona (np. limit, brak środków). Transakcja zostaje wtedy COFNIĘTA,
// więc przedmiot się nie zużywa. Komendy łapią ten błąd i pokazują komunikat.
class Refused extends Error {}

const raw = () => db.raw;

// ---------------- ODCZYT ----------------
async function getInventory(guildId, userId) {
  const res = await raw().query(
    'SELECT item_id, quantity FROM inventory WHERE guild_id = $1 AND user_id = $2 AND quantity > 0',
    [guildId, userId],
  );
  return res.rows.map((r) => ({ itemId: r.item_id, quantity: Number(r.quantity) }));
}

async function getBoosts(guildId, userId, now = Date.now()) {
  const res = await raw().query(
    'SELECT family, value, expires_at FROM user_boosts WHERE guild_id = $1 AND user_id = $2 AND expires_at > $3::bigint',
    [guildId, userId, now],
  );
  return res.rows.map((r) => ({ family: r.family, value: Number(r.value), expiresAt: Number(r.expires_at) }));
}

async function getLuck(guildId, userId) {
  return items.computeLuck(await getBoosts(guildId, userId));
}

async function getArmed(guildId, userId) {
  const res = await raw().query('SELECT kind, item_id FROM user_armed WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
  return Object.fromEntries(res.rows.map((r) => [r.kind, r.item_id]));
}

// Zbiór posiadanych przedmiotów unikalnych (stałe i kolekcjonerskie), żeby losowanie ich nie dublowało
async function getOwnedUnique(guildId, userId) {
  const inv = await getInventory(guildId, userId);
  return new Set(inv.filter((i) => items.ITEMS[i.itemId]?.unique).map((i) => i.itemId));
}

// ---------------- ZMIANY (zawsze wewnątrz transakcji: client z db.withTransaction) ----------------
// Dodaje przedmiot. Unikalny przedmiot, który już masz, jest pomijany (zwraca false).
async function addItem(client, guildId, userId, itemId, qty = 1) {
  const def = items.getDef(itemId);
  if (!def) throw new Error(`addItem: nieznany przedmiot "${itemId}"`);
  if (def.unique) {
    const res = await client.query(`
      INSERT INTO inventory (guild_id, user_id, item_id, quantity) VALUES ($1, $2, $3, 1)
      ON CONFLICT (guild_id, user_id, item_id) DO NOTHING RETURNING quantity
    `, [guildId, userId, itemId]);
    return res.rowCount > 0;
  }
  await client.query(`
    INSERT INTO inventory (guild_id, user_id, item_id, quantity) VALUES ($1, $2, $3, $4)
    ON CONFLICT (guild_id, user_id, item_id) DO UPDATE SET quantity = inventory.quantity + $4
  `, [guildId, userId, itemId, qty]);
  return true;
}

// Zabiera przedmiot TYLKO jeśli jest (jedno zapytanie, więc nie da się zużyć tego samego dwa razy)
async function removeItem(client, guildId, userId, itemId, qty = 1) {
  const res = await client.query(`
    UPDATE inventory SET quantity = quantity - $4
    WHERE guild_id = $1 AND user_id = $2 AND item_id = $3 AND quantity >= $4
    RETURNING quantity
  `, [guildId, userId, itemId, qty]);
  if (res.rowCount === 0) return false;
  if (Number(res.rows[0].quantity) === 0) {
    await client.query('DELETE FROM inventory WHERE guild_id = $1 AND user_id = $2 AND item_id = $3 AND quantity = 0', [guildId, userId, itemId]);
  }
  return true;
}

// ---------------- ZAKUP SKRZYNI ----------------
// Pobranie monet, wpis w dzienniku i dodanie skrzyni do ekwipunku w jednej transakcji.
async function buyChest(guildId, userId, chestId) {
  const chest = items.CHESTS[chestId];
  if (!chest || chest.legacy) throw new Refused('Nie ma takiej skrzyni.');

  return db.withTransaction(async (c) => {
    const res = await c.query(`
      UPDATE economy_accounts SET balance = balance - $3::bigint
      WHERE guild_id = $1 AND user_id = $2 AND balance >= $3::bigint
      RETURNING balance
    `, [guildId, userId, chest.price]);
    if (res.rowCount === 0) return { ok: false, reason: 'funds' };

    const balance = Number(res.rows[0].balance);
    await c.query(`
      INSERT INTO economy_transactions (guild_id, user_id, amount, balance_after, reason, created_at)
      VALUES ($1, $2, $3::bigint, $4::bigint, $5, $6::bigint)
    `, [guildId, userId, -chest.price, balance, `shop_${chestId}`, Date.now()]);
    await addItem(c, guildId, userId, chestId, 1);
    return { ok: true, balance };
  });
}

// ---------------- OTWARCIE KUPIONEJ SKRZYNI ----------------
// Zabranie skrzyni z ekwipunku, wypłata monet i dodanie przedmiotów w jednej transakcji.
async function settleChestOpen(guildId, userId, chestId, coins, itemIds) {
  return db.withTransaction(async (c) => {
    if (!(await removeItem(c, guildId, userId, chestId, 1))) return { ok: false, reason: 'missing' };

    let balance;
    if (coins > 0) {
      balance = await db.applyCredit(c, guildId, userId, coins, 'chest_open', true);
    } else {
      const row = await c.query('SELECT balance FROM economy_accounts WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
      balance = Number(row.rows[0]?.balance ?? 0);
    }

    const granted = [];
    for (const id of itemIds) if (await addItem(c, guildId, userId, id, 1)) granted.push(id);
    return { ok: true, balance, granted };
  });
}

// ---------------- DZIENNA NAGRODA ----------------
// Sprawdzenie "czy już odebrano dziś (czas polski)", wypłata monet, dodanie przedmiotów i zużycie
// uzbrojonych modyfikatorów (Latarka/Klucz/Budzik) w jednej transakcji.
async function claimDailyBundle(guildId, userId, coins, itemIds = [], consumeKinds = []) {
  return db.withTransaction(async (c) => {
    await c.query(`
      INSERT INTO user_levels (guild_id, user_id, xp, level) VALUES ($1, $2, 0, 0)
      ON CONFLICT (guild_id, user_id) DO NOTHING
    `, [guildId, userId]);

    const claim = await c.query(`
      UPDATE user_levels SET last_daily_at = $3::bigint
      WHERE guild_id = $1 AND user_id = $2
        AND (
          last_daily_at IS NULL
          OR (to_timestamp(last_daily_at / 1000.0) AT TIME ZONE 'Europe/Warsaw')::date
             <> (now() AT TIME ZONE 'Europe/Warsaw')::date
        )
      RETURNING user_id
    `, [guildId, userId, Date.now()]);
    if (claim.rowCount === 0) return { claimed: false };

    const balance = await db.applyCredit(c, guildId, userId, coins, 'daily', true);

    const granted = [];
    for (const id of itemIds) if (await addItem(c, guildId, userId, id, 1)) granted.push(id);
    for (const kind of consumeKinds) {
      await c.query('DELETE FROM user_armed WHERE guild_id = $1 AND user_id = $2 AND kind = $3', [guildId, userId, kind]);
    }
    return { claimed: true, balance, granted };
  });
}

module.exports = {
  Refused,
  getInventory, getBoosts, getLuck, getArmed, getOwnedUnique,
  addItem, removeItem,
  buyChest, settleChestOpen, claimDailyBundle,
};
