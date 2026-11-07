const db = require('../db');
const items = require('./items');

// Rzucany, gdy akcja jest niedozwolona (np. limit, brak środków). Transakcja zostaje wtedy COFNIĘTA,
// więc przedmiot się nie zużywa. Komendy łapią ten błąd i pokazują komunikat.
class Refused extends Error {}

const raw = () => db.raw;

// Przedmioty stałe ze szczęściem (poziom = ilość w ekwipunku)
const LUCK_ITEM_IDS = ['koniczyna', 'podkowa'];

// ---------------- ODCZYT ----------------
async function getInventory(guildId, userId) {
  const res = await raw().query(
    'SELECT item_id, quantity FROM inventory WHERE guild_id = $1 AND user_id = $2 AND quantity > 0',
    [guildId, userId],
  );
  return res.rows.map((r) => ({ itemId: r.item_id, quantity: Number(r.quantity) }));
}

// (Stare, czasowe szczęście. Nowy system go nie używa, ale tabela user_boosts nadal istnieje.)
async function getBoosts(guildId, userId, now = Date.now()) {
  const res = await raw().query(
    'SELECT family, value, expires_at FROM user_boosts WHERE guild_id = $1 AND user_id = $2 AND expires_at > $3::bigint',
    [guildId, userId, now],
  );
  return res.rows.map((r) => ({ family: r.family, value: Number(r.value), expiresAt: Number(r.expires_at) }));
}

// Szczęście z ekwipunku: poziomy Koniczyny i Podkowy (stałe, działają zawsze) + włączona Koniczynka (na jedną skrzynię).
// Zwraca rozpisanie (patrz items.luckBreakdown): { koniczynaLevel, podkowaLevel, koniczyna, podkowa, combo, once, raw, luck }
async function getLuckBreakdown(guildId, userId) {
  const [owned, once] = await Promise.all([
    raw().query(
      'SELECT item_id, quantity FROM inventory WHERE guild_id = $1 AND user_id = $2 AND item_id = ANY($3::text[]) AND quantity > 0',
      [guildId, userId, LUCK_ITEM_IDS],
    ),
    raw().query("SELECT 1 FROM user_armed WHERE guild_id = $1 AND user_id = $2 AND kind = 'luck_once'", [guildId, userId]),
  ]);
  const level = Object.fromEntries(owned.rows.map((r) => [r.item_id, Number(r.quantity)]));
  return items.luckBreakdown({ koniczyna: level.koniczyna ?? 0, podkowa: level.podkowa ?? 0, once: once.rowCount > 0 });
}

async function getLuck(guildId, userId) {
  return (await getLuckBreakdown(guildId, userId)).luck;
}

// Licznik pecha 0..1 dla danego rodzaju skrzyni: 'daily' albo id skrzyni ze sklepu
async function getPity(guildId, userId, source) {
  const res = await raw().query(
    'SELECT meter FROM user_pity WHERE guild_id = $1 AND user_id = $2 AND source = $3',
    [guildId, userId, source],
  );
  return Number(res.rows[0]?.meter ?? 0);
}

// Liczniki pecha ze wszystkich rodzajów skrzyń: { daily: 0.3, chest_braz: 0, ... }
async function getAllPity(guildId, userId) {
  const res = await raw().query('SELECT source, meter FROM user_pity WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
  return Object.fromEntries(res.rows.map((r) => [r.source, Number(r.meter)]));
}

async function getArmed(guildId, userId) {
  const res = await raw().query('SELECT kind, item_id FROM user_armed WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
  return Object.fromEntries(res.rows.map((r) => [r.kind, r.item_id]));
}

// Zbiór przedmiotów, które nie mogą już wypaść: unikalne, które już masz, oraz przedmioty z poziomami
// na maksymalnym poziomie (Koniczyna i Podkowa na poziomie 5).
async function getOwnedUnique(guildId, userId) {
  const inv = await getInventory(guildId, userId);
  return new Set(inv
    .filter((i) => {
      const def = items.ITEMS[i.itemId];
      return def?.unique && i.quantity >= (def.maxLevel ?? 1);
    })
    .map((i) => i.itemId));
}

// ---------------- ZMIANY (zawsze wewnątrz transakcji: client z db.withTransaction) ----------------
// Dodaje przedmiot. Zwraca:
//   true     zwykły przedmiot dodany
//   liczbę   przedmiot z poziomami (Koniczyna, Podkowa): NOWY poziom (kolejna sztuka podnosi poziom)
//   false    pominięty (unikalny, który już masz, albo poziom już maksymalny)
async function addItem(client, guildId, userId, itemId, qty = 1) {
  const def = items.getDef(itemId);
  if (!def) throw new Error(`addItem: nieznany przedmiot "${itemId}"`);
  if (def.maxLevel) {
    const res = await client.query(`
      INSERT INTO inventory (guild_id, user_id, item_id, quantity) VALUES ($1, $2, $3, 1)
      ON CONFLICT (guild_id, user_id, item_id) DO UPDATE SET quantity = inventory.quantity + 1
      WHERE inventory.quantity < $4::int
      RETURNING quantity
    `, [guildId, userId, itemId, def.maxLevel]);
    return res.rowCount > 0 ? Number(res.rows[0].quantity) : false;
  }
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

// Dodaje wszystkie przedmioty z listy; zwraca { granted: [id...], levels: { id: nowyPoziom } }
async function addItems(c, guildId, userId, itemIds) {
  const granted = [];
  const levels = {};
  for (const id of itemIds) {
    const added = await addItem(c, guildId, userId, id, 1);
    if (!added) continue;
    granted.push(id);
    if (typeof added === 'number') levels[id] = added;
  }
  return { granted, levels };
}

// Aktualizacja licznika pecha w tej samej transakcji co otwarcie skrzyni.
// pity = { source, delta }: delta > 0 (słabe losowanie) podnosi licznik, delta < 0 (dobry wynik) obniża. Licznik jest przycięty do 0..1,
// więc bonus z pecha nigdy nie jest ujemny.
async function applyPity(c, guildId, userId, pity) {
  if (!pity || !Number.isFinite(pity.delta)) return;
  const start = Math.min(1, Math.max(0, pity.delta));
  await c.query(`
    INSERT INTO user_pity (guild_id, user_id, source, meter) VALUES ($1, $2, $3, $4::double precision)
    ON CONFLICT (guild_id, user_id, source) DO UPDATE
    SET meter = GREATEST(0, LEAST(1, user_pity.meter + $5::double precision))
  `, [guildId, userId, pity.source, start, pity.delta]);
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
// Zabranie skrzyni z ekwipunku, wypłata monet, dodanie przedmiotów, zużycie jednorazowego bonusu (Koniczynka)
// i aktualizacja licznika pecha w jednej transakcji.
//   extra = { consumeKinds: ['luck_once'], pity: { source, delta } }
async function settleChestOpen(guildId, userId, chestId, coins, itemIds, extra = {}) {
  const { consumeKinds = [], pity = null } = extra;
  return db.withTransaction(async (c) => {
    if (!(await removeItem(c, guildId, userId, chestId, 1))) return { ok: false, reason: 'missing' };

    let balance;
    if (coins > 0) {
      balance = await db.applyCredit(c, guildId, userId, coins, 'chest_open', true);
    } else {
      const row = await c.query('SELECT balance FROM economy_accounts WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
      balance = Number(row.rows[0]?.balance ?? 0);
    }

    const { granted, levels } = await addItems(c, guildId, userId, itemIds);
    for (const kind of consumeKinds) {
      await c.query('DELETE FROM user_armed WHERE guild_id = $1 AND user_id = $2 AND kind = $3', [guildId, userId, kind]);
    }
    await applyPity(c, guildId, userId, pity);
    return { ok: true, balance, granted, levels };
  });
}

// ---------------- DZIENNA NAGRODA ----------------
// Sprawdzenie "czy już odebrano dziś (czas polski)", wypłata monet, dodanie przedmiotów, zużycie
// uzbrojonych modyfikatorów (Latarka/Klucz/Budzik/Koniczynka) i aktualizacja licznika pecha w jednej transakcji.
async function claimDailyBundle(guildId, userId, coins, itemIds = [], consumeKinds = [], pity = null) {
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

    const { granted, levels } = await addItems(c, guildId, userId, itemIds);
    for (const kind of consumeKinds) {
      await c.query('DELETE FROM user_armed WHERE guild_id = $1 AND user_id = $2 AND kind = $3', [guildId, userId, kind]);
    }
    await applyPity(c, guildId, userId, pity);
    return { claimed: true, balance, granted, levels };
  });
}

module.exports = {
  Refused,
  getInventory, getBoosts, getLuckBreakdown, getLuck, getPity, getAllPity, getArmed, getOwnedUnique,
  addItem, removeItem,
  buyChest, settleChestOpen, claimDailyBundle,
};
