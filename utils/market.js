const db = require('../db');
const items = require('./items');
const inv = require('./inventory');

// ============================================================
//  RYNEK GRACZY
//  Wystawiony przedmiot znika z ekwipunku i leży "w depozycie" (market_listings, status 'active').
//  Wszystkie zmiany (wystawienie, kupno, anulowanie, wygaśnięcie) to JEDNA transakcja w bazie,
//  a oferta jest blokowana (FOR UPDATE), więc ten sam przedmiot nie może się sprzedać ani wrócić dwa razy.
// ============================================================

const FEE = Number(process.env.MARKET_FEE ?? 0.05); // prowizja od ceny, płacona przez sprzedawcę (znika z gry)
const LISTING_DAYS = Number(process.env.MARKET_LISTING_DAYS ?? 7);
const MAX_LISTINGS = Number(process.env.MARKET_MAX_LISTINGS ?? 5);
const SWEEP_EVERY_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

// Widełki cen (monety): [min, max]. Twarde granice, żeby nie dało się "sprzedawać" przedmiotów za 1 monetę
// albo przerzucać milionów między kontami jedną ofertą. Unikaty mają własne, wyższe widełki.
const PRICE_BY_TIER = {
  0: [50, 1_000],
  1: [150, 3_000],
  2: [400, 10_000],
  3: [1_500, 40_000],
  4: [5_000, 150_000],
  5: [20_000, 500_000],
  6: [50_000, 1_000_000],
};
const PRICE_BY_ITEM = {
  krzeslo: [12_000, 1_200_000],
  zegarek: [15_000, 1_500_000],
  powerbank: [15_000, 1_500_000],
  notes: [25_000, 2_500_000],
  zlota_teczka: [25_000, 2_500_000],
  dyplom: [25_000, 2_500_000],
  ekspres: [12_000, 1_200_000],
  koniczyna: [15_000, 1_500_000],
  podkowa: [40_000, 3_000_000],
  korona: [100_000, 5_000_000],
  moneta_void: [250_000, 10_000_000],
};

// Skrzynie się nie handlują (otwiera się je na kanale); reszta przedmiotów tak
const isTradable = (itemId) => Boolean(items.ITEMS[itemId]) && !items.isChest(itemId);

function priceRange(itemId) {
  const def = items.ITEMS[itemId];
  if (!def) return null;
  return PRICE_BY_ITEM[itemId] ?? PRICE_BY_TIER[def.tier] ?? [50, 1_000_000];
}

// Zaokrągla do 2 cyfr znaczących (4 237 -> 4 200), żeby sugerowana cena wyglądała ładnie
function niceRound(n) {
  if (n < 100) return Math.max(1, Math.round(n));
  const mag = 10 ** (Math.floor(Math.log10(n)) - 1);
  return Math.round(n / mag) * mag;
}

// Sugerowana cena: średnia z ostatnich 5 sprzedaży tego przedmiotu na serwerze, a bez historii środek widełek (średnia geometryczna)
async function suggestedPrice(guildId, itemId) {
  const [min, max] = priceRange(itemId) ?? [0, 0];
  const res = await db.raw.query(
    "SELECT price FROM market_listings WHERE guild_id = $1 AND item_id = $2 AND status = 'sold' ORDER BY closed_at DESC LIMIT 5",
    [guildId, itemId],
  );
  if (res.rowCount > 0) {
    const avg = res.rows.reduce((s, r) => s + Number(r.price), 0) / res.rowCount;
    return { price: Math.min(max, Math.max(min, niceRound(avg))), fromSales: res.rowCount };
  }
  return { price: niceRound(Math.sqrt(min * max)), fromSales: 0 };
}

// Zamienia wpis gracza na liczbę: "4200", "4 200", "4.200", "4,2k", "1,5m". Zwraca null, gdy to nie cena.
function parsePrice(input) {
  let s = String(input ?? '').trim().toLowerCase().replace(/[\s ]/g, '');
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ''); // 15.000 = piętnaście tysięcy
  s = s.replace(',', '.');
  const m = /^(\d+(?:\.\d+)?)(k|tys|m|mln)?$/.exec(s);
  if (!m) return null;
  const mult = m[2] === 'k' || m[2] === 'tys' ? 1_000 : m[2] === 'm' || m[2] === 'mln' ? 1_000_000 : 1;
  const value = Math.round(Number(m[1]) * mult);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

// Magazyn (stały przedmiot sprzedawcy) obniża prowizję i zwiększa limit ofert
const feeRate = (level = 0) => Math.max(0.02, FEE - Math.max(0, level) * items.PERKS.FEE_STEP);
const feeOf = (price, level = 0) => Math.floor(price * feeRate(level));
const limitFor = (level = 0) => MAX_LISTINGS + Math.max(0, level) * items.PERKS.SLOTS_PER_LEVEL;
async function perksFor(guildId, userId, c) {
  const level = await inv.itemLevel(guildId, userId, 'magazyn', c);
  return { level, limit: limitFor(level), fee: feeRate(level) };
}

// ---------------- ODCZYT ----------------
// Przedmioty, które gracz może wystawić (z ekwipunku, bez skrzyń), od najwyższej rzadkości
async function getSellable(guildId, userId) {
  const inventory = await inv.getInventory(guildId, userId);
  return inventory
    .filter((i) => isTradable(i.itemId))
    .sort((a, b) => items.ITEMS[b.itemId].tier - items.ITEMS[a.itemId].tier || a.itemId.localeCompare(b.itemId));
}

const mapListing = (r) => ({
  id: Number(r.id),
  sellerId: r.seller_id,
  itemId: r.item_id,
  price: Number(r.price),
  createdAt: Number(r.created_at),
  expiresAt: Number(r.expires_at),
});

// Aktywne oferty (bez wygasłych). tier = null: wszystkie rzadkości. Zwraca { rows, total }.
async function getListings(guildId, { tier = null, limit = 5, offset = 0, now = Date.now() } = {}) {
  const ids = tier === null ? null : Object.values(items.ITEMS).filter((d) => d.tier === tier).map((d) => d.id);
  const where = "guild_id = $1 AND status = 'active' AND expires_at > $2::bigint AND ($3::text[] IS NULL OR item_id = ANY($3::text[]))";
  const [rows, total] = await Promise.all([
    db.raw.query(`SELECT * FROM market_listings WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $4 OFFSET $5`, [guildId, now, ids, limit, offset]),
    db.raw.query(`SELECT COUNT(*)::int AS n FROM market_listings WHERE ${where}`, [guildId, now, ids]),
  ]);
  return { rows: rows.rows.map(mapListing), total: total.rows[0].n };
}

// Jedna aktywna, niewygasła oferta (albo null)
async function getListing(guildId, listingId, now = Date.now()) {
  const res = await db.raw.query(
    "SELECT * FROM market_listings WHERE id = $1 AND guild_id = $2 AND status = 'active' AND expires_at > $3::bigint",
    [listingId, guildId, now],
  );
  return res.rows[0] ? mapListing(res.rows[0]) : null;
}

async function getMyListings(guildId, userId) {
  const res = await db.raw.query(
    "SELECT * FROM market_listings WHERE guild_id = $1 AND seller_id = $2 AND status = 'active' ORDER BY created_at DESC, id DESC",
    [guildId, userId],
  );
  return res.rows.map(mapListing);
}

// Ostatnie sprzedaże gracza (sprzedawca nie dostaje powiadomienia, więc pokazujemy je w "Moje oferty")
async function getRecentSales(guildId, userId, limit = 3) {
  const res = await db.raw.query(
    "SELECT * FROM market_listings WHERE guild_id = $1 AND seller_id = $2 AND status = 'sold' ORDER BY closed_at DESC LIMIT $3",
    [guildId, userId, limit],
  );
  return res.rows.map((r) => ({ ...mapListing(r), buyerId: r.buyer_id, fee: Number(r.fee), closedAt: Number(r.closed_at) }));
}

// ---------------- ZMIANY ----------------
const writeLedger = (c, guildId, userId, amount, balanceAfter, reason, now) =>
  c.query(
    `INSERT INTO economy_transactions (guild_id, user_id, amount, balance_after, reason, created_at)
     VALUES ($1, $2, $3::bigint, $4::bigint, $5, $6::bigint)`,
    [guildId, userId, amount, balanceAfter, reason, now],
  );

// Wystawia przedmiot. Zwraca { ok: true, id, expiresAt } albo { ok: false, reason, ... }:
//   'item' (nie można go sprzedawać), 'price' (poza widełkami, + min/max), 'limit', 'missing' (nie masz go)
async function listItem(guildId, userId, itemId, price, now = Date.now()) {
  if (!isTradable(itemId)) return { ok: false, reason: 'item' };
  const [min, max] = priceRange(itemId);
  if (!Number.isSafeInteger(price) || price < min || price > max) return { ok: false, reason: 'price', min, max };

  return db.withTransaction(async (c) => {
    // blokada na sprzedawcę: dwa szybkie kliknięcia nie przekroczą limitu ofert
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`market:${guildId}:${userId}`]);
    const count = await c.query("SELECT COUNT(*)::int AS n FROM market_listings WHERE guild_id = $1 AND seller_id = $2 AND status = 'active'", [guildId, userId]);
    if (count.rows[0].n >= limitFor(await inv.itemLevel(guildId, userId, 'magazyn', c))) return { ok: false, reason: 'limit' };

    if (!(await inv.removeItem(c, guildId, userId, itemId, 1))) return { ok: false, reason: 'missing' };

    const expiresAt = now + LISTING_DAYS * DAY_MS;
    const res = await c.query(
      `INSERT INTO market_listings (guild_id, seller_id, item_id, price, created_at, expires_at)
       VALUES ($1, $2, $3, $4::bigint, $5::bigint, $6::bigint) RETURNING id`,
      [guildId, userId, itemId, price, now, expiresAt],
    );
    return { ok: true, id: Number(res.rows[0].id), expiresAt };
  });
}

// Kupno: pobranie monet, przedmiot dla kupującego, wypłata dla sprzedawcy (cena minus prowizja) i zamknięcie oferty w jednej transakcji.
// Zwraca { ok: true, balance, price, fee, itemId, sellerId } albo { ok: false, reason }:
//   'gone' (oferta już nieaktualna), 'own' (własna oferta), 'funds' (za mało monet), 'cannot_hold' (nie możesz mieć tego przedmiotu, np. masz już unikat albo maksymalny poziom)
async function buyListing(guildId, buyerId, listingId, now = Date.now()) {
  try {
    return await db.withTransaction(async (c) => {
      const found = await c.query('SELECT * FROM market_listings WHERE id = $1 AND guild_id = $2 FOR UPDATE', [listingId, guildId]);
      const l = found.rows[0];
      if (!l || l.status !== 'active' || Number(l.expires_at) <= now) return { ok: false, reason: 'gone' };
      if (l.seller_id === buyerId) return { ok: false, reason: 'own' };

      const price = Number(l.price);
      const fee = feeOf(price, await inv.itemLevel(guildId, l.seller_id, 'magazyn', c));

      // Konta blokujemy zawsze w tej samej kolejności, żeby dwie wymiany "na krzyż" nie zakleszczyły się
      await c.query(
        `INSERT INTO economy_accounts (guild_id, user_id, balance, total_earned, created_at)
         VALUES ($1, $2, 0, 0, $3::bigint) ON CONFLICT (guild_id, user_id) DO NOTHING`,
        [guildId, l.seller_id, now],
      );
      await c.query('SELECT 1 FROM economy_accounts WHERE guild_id = $1 AND user_id = ANY($2::text[]) ORDER BY user_id FOR UPDATE', [guildId, [buyerId, l.seller_id]]);

      const debit = await c.query(
        'UPDATE economy_accounts SET balance = balance - $3::bigint WHERE guild_id = $1 AND user_id = $2 AND balance >= $3::bigint RETURNING balance',
        [guildId, buyerId, price],
      );
      if (debit.rowCount === 0) return { ok: false, reason: 'funds', price };
      const balance = Number(debit.rows[0].balance);

      // Jeśli kupujący nie może przyjąć przedmiotu, wyjątek cofa całą transakcję (łącznie z pobranymi monetami)
      const added = await inv.addItem(c, guildId, buyerId, l.item_id, 1);
      if (!added) throw new inv.Refused('cannot_hold');

      await writeLedger(c, guildId, buyerId, -price, balance, 'market_buy', now);
      // Wypłata bez zwiększania total_earned (to nie jest zarobek z gry)
      const credit = await c.query(
        'UPDATE economy_accounts SET balance = balance + $3::bigint WHERE guild_id = $1 AND user_id = $2 RETURNING balance',
        [guildId, l.seller_id, price - fee],
      );
      await writeLedger(c, guildId, l.seller_id, price - fee, Number(credit.rows[0].balance), 'market_sale', now);

      await c.query("UPDATE market_listings SET status = 'sold', buyer_id = $2, closed_at = $3::bigint, fee = $4::bigint WHERE id = $1", [listingId, buyerId, now, fee]);
      return { ok: true, balance, price, fee, itemId: l.item_id, sellerId: l.seller_id };
    });
  } catch (err) {
    if (err instanceof inv.Refused) return { ok: false, reason: 'cannot_hold' };
    throw err;
  }
}

// Zwrot przedmiotu z depozytu do sprzedawcy. Jeśli nie da się go już przyjąć (wyjątkowa sytuacja: np. unikat
// zdobyty w międzyczasie), sprzedawca dostaje rekompensatę w wysokości dolnej granicy widełek, żeby nic nie przepadło.
async function returnItem(c, l, now) {
  const added = await inv.addItem(c, l.guild_id, l.seller_id, l.item_id, 1);
  if (added) return { compensated: 0 };
  const [min] = priceRange(l.item_id) ?? [0];
  const res = await c.query(
    `INSERT INTO economy_accounts (guild_id, user_id, balance, total_earned, created_at)
     VALUES ($1, $2, $3::bigint, 0, $4::bigint)
     ON CONFLICT (guild_id, user_id) DO UPDATE SET balance = economy_accounts.balance + $3::bigint RETURNING balance`,
    [l.guild_id, l.seller_id, min, now],
  );
  await writeLedger(c, l.guild_id, l.seller_id, min, Number(res.rows[0].balance), 'market_return_fallback', now);
  return { compensated: min };
}

// Anulowanie własnej oferty: przedmiot wraca do ekwipunku. { ok: true, itemId, compensated } albo { ok: false, reason: 'gone' | 'notyours' }
async function cancelListing(guildId, userId, listingId, now = Date.now()) {
  return db.withTransaction(async (c) => {
    const found = await c.query('SELECT * FROM market_listings WHERE id = $1 AND guild_id = $2 FOR UPDATE', [listingId, guildId]);
    const l = found.rows[0];
    if (!l || l.status !== 'active') return { ok: false, reason: 'gone' };
    if (l.seller_id !== userId) return { ok: false, reason: 'notyours' };
    const back = await returnItem(c, l, now);
    await c.query("UPDATE market_listings SET status = 'cancelled', closed_at = $2::bigint WHERE id = $1", [listingId, now]);
    return { ok: true, itemId: l.item_id, compensated: back.compensated };
  });
}

// Wygasłe oferty wracają do sprzedawców. Bez argumentów: cały bot; { guildId, userId }: tylko oferty jednej osoby.
// Zwraca liczbę zwróconych ofert.
async function expireDue({ guildId = null, userId = null, now = Date.now() } = {}) {
  const due = await db.raw.query(
    `SELECT id FROM market_listings
     WHERE status = 'active' AND expires_at <= $1::bigint
       AND ($2::text IS NULL OR guild_id = $2) AND ($3::text IS NULL OR seller_id = $3)
     ORDER BY id LIMIT 500`,
    [now, guildId, userId],
  );
  let done = 0;
  for (const { id } of due.rows) {
    const ok = await db.withTransaction(async (c) => {
      const row = await c.query("SELECT * FROM market_listings WHERE id = $1 AND status = 'active' AND expires_at <= $2::bigint FOR UPDATE SKIP LOCKED", [id, now]);
      const l = row.rows[0];
      if (!l) return false;
      await returnItem(c, l, now);
      await c.query("UPDATE market_listings SET status = 'expired', closed_at = $2::bigint WHERE id = $1", [id, now]);
      return true;
    }).catch((err) => {
      console.error('Rynek: nie udało się zwrócić wygasłej oferty', id, err.message);
      return false;
    });
    if (ok) done++;
  }
  return done;
}

// Co jakiś czas zwraca wygasłe oferty (także gdy nikt nie otwiera rynku)
let sweeper = null;
function startSweeper() {
  if (sweeper) return;
  const run = () => expireDue().catch((err) => console.error('Rynek: błąd sprzątania ofert:', err.message));
  setTimeout(run, 30_000).unref?.();
  sweeper = setInterval(run, SWEEP_EVERY_MS);
  sweeper.unref?.();
}

module.exports = {
  FEE,
  LISTING_DAYS,
  MAX_LISTINGS,
  PRICE_BY_TIER,
  PRICE_BY_ITEM,
  isTradable,
  priceRange,
  suggestedPrice,
  parsePrice,
  feeOf,
  feeRate,
  limitFor,
  perksFor,
  getSellable,
  getListings,
  getListing,
  getMyListings,
  getRecentSales,
  listItem,
  buyListing,
  cancelListing,
  expireDue,
  startSweeper,
};
