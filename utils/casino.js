const { randomInt } = require('node:crypto');

// ============================================================
//  KONFIGURACJA KASYNA - zmieniasz tutaj albo w .env
// ============================================================
const MIN_BET = Number(process.env.CASINO_MIN_BET ?? 10);
const MAX_BET = Number(process.env.CASINO_MAX_BET ?? 2000);
// Przerwa między grami jednej osoby (ms), liczona od końca poprzedniej gry
const COOLDOWN_MS = Number(process.env.CASINO_COOLDOWN_MS ?? 3000);

// ------------------------------------------------------------
//  ORZEŁ / RESZKA
//  Wygrana = stawka x2 (czyli +100% stawki). Szansa 48%, więc zwrot to 96%.
// ------------------------------------------------------------
const COIN_WIN_CHANCE_PER_1000 = 480;

function flipCoin(side) {
  const win = randomInt(0, 1000) < COIN_WIN_CHANCE_PER_1000;
  const other = side === 'orzel' ? 'reszka' : 'orzel';
  return { win, result: win ? side : other, multiplier: win ? 2 : 0 };
}

// ------------------------------------------------------------
//  AUTOMAT (3 bębny)
//  weight = waga losowania (suma wag = 100), triple = mnożnik za trzy takie same.
//  Dwa takie same: tylko wiśnie (x1.5) i cytryny (x0.5) coś zwracają.
// ------------------------------------------------------------
const SLOT_SYMBOLS = [
  { emoji: '🍒', weight: 32, triple: 6 },
  { emoji: '🍋', weight: 26, triple: 10 },
  { emoji: '🍇', weight: 20, triple: 15 },
  { emoji: '🔔', weight: 12, triple: 30 },
  { emoji: '💎', weight: 7, triple: 75 },
  { emoji: '7️⃣', weight: 3, triple: 250 },
];
const SLOT_PAIR = { '🍒': 1.5, '🍋': 0.5 };
const SLOT_TOTAL_WEIGHT = SLOT_SYMBOLS.reduce((sum, s) => sum + s.weight, 0);

function spinReel() {
  let roll = randomInt(0, SLOT_TOTAL_WEIGHT);
  for (const symbol of SLOT_SYMBOLS) {
    if (roll < symbol.weight) return symbol;
    roll -= symbol.weight;
  }
  return SLOT_SYMBOLS[0];
}

// Mnożnik dla układu trzech emoji (używane też do liczenia dokładnego zwrotu)
function slotMultiplier(a, b, c) {
  if (a.emoji === b.emoji && b.emoji === c.emoji) return { multiplier: a.triple, kind: 'triple' };
  const pair = a.emoji === b.emoji ? a : b.emoji === c.emoji ? b : a.emoji === c.emoji ? a : null;
  if (pair && SLOT_PAIR[pair.emoji]) return { multiplier: SLOT_PAIR[pair.emoji], kind: 'pair' };
  return { multiplier: 0, kind: 'none' };
}

function spinSlots() {
  const reels = [spinReel(), spinReel(), spinReel()];
  const { multiplier, kind } = slotMultiplier(...reels);
  return { reels: reels.map((r) => r.emoji), multiplier, kind };
}

// ------------------------------------------------------------
//  RULETKA (europejska: 0-36, jedno zero)
//  Zakłady zewnętrzne płacą x2, numer płaci x36. Zero przegrywa wszystko.
// ------------------------------------------------------------
const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

const ROULETTE_BETS = {
  czerwone: { label: '🔴 Czerwone', multiplier: 2, test: (n) => RED_NUMBERS.has(n) },
  czarne: { label: '⚫ Czarne', multiplier: 2, test: (n) => n !== 0 && !RED_NUMBERS.has(n) },
  parzyste: { label: 'Parzyste', multiplier: 2, test: (n) => n !== 0 && n % 2 === 0 },
  nieparzyste: { label: 'Nieparzyste', multiplier: 2, test: (n) => n % 2 === 1 },
  niskie: { label: 'Niskie (1-18)', multiplier: 2, test: (n) => n >= 1 && n <= 18 },
  wysokie: { label: 'Wysokie (19-36)', multiplier: 2, test: (n) => n >= 19 },
  zielone: { label: '🟢 Zielone (0)', multiplier: 36, test: (n) => n === 0 },
  numer: { label: 'Numer', multiplier: 36, test: null },
};

function rouletteColor(n) {
  if (n === 0) return '🟢';
  return RED_NUMBERS.has(n) ? '🔴' : '⚫';
}

function spinRoulette(kind, chosenNumber) {
  const number = randomInt(0, 37);
  const bet = ROULETTE_BETS[kind];
  const win = kind === 'numer' ? number === chosenNumber : bet.test(number);
  return { number, color: rouletteColor(number), win, multiplier: win ? bet.multiplier : 0 };
}

// ------------------------------------------------------------
//  ROZLICZENIE STAWKI
//  Pobranie stawki, wypłata wygranej i wpis w dzienniku dzieją się w JEDNEJ transakcji,
//  więc awaria bota w trakcie animacji nie zgubi ani nie zdubluje monet,
//  a dwa równoległe kliknięcia nie wydadzą tych samych monet.
//  Zwraca nowe saldo albo null, gdy saldo nie wystarcza na stawkę.
//  W dzienniku zapisywany jest wynik netto (wygrana minus stawka).
// ------------------------------------------------------------
async function settleBetEx(guildId, userId, bet, payout, reason) {
  if (!Number.isSafeInteger(bet) || bet <= 0) throw new Error('settleBet: stawka musi być dodatnią liczbą całkowitą');
  if (!Number.isSafeInteger(payout) || payout < 0) throw new Error('settleBet: wypłata musi być liczbą całkowitą >= 0');

  const db = require('../db'); // wczytywane tutaj, żeby logikę gier dało się testować bez bazy
  const client = await db.raw.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query(`
      UPDATE economy_accounts
      SET balance = balance - $3::bigint + $4::bigint
      WHERE guild_id = $1 AND user_id = $2 AND balance >= $3::bigint
      RETURNING balance
    `, [guildId, userId, bet, payout]);

    if (res.rowCount === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    let balance = Number(res.rows[0].balance);

    // POLISA (przedmiot): jeśli gracz ją włączył, zużywa się przy TEJ grze (niezależnie od wyniku).
    // Po przegranej jest szansa na zwrot straty do limitu. Wszystko w tej samej transakcji co rozliczenie.
    let insurance = null;
    const armed = await client.query(
      `DELETE FROM user_armed WHERE guild_id = $1 AND user_id = $2 AND kind = 'polisa' RETURNING item_id`,
      [guildId, userId],
    );
    const def = armed.rowCount > 0 ? require('./items').ITEMS[armed.rows[0].item_id] : null;
    let refund = 0;
    if (def && def.use?.type === 'polisa') {
      const lost = bet - payout;
      if (lost > 0 && randomInt(0, 100) < def.use.chance) refund = Math.min(lost, def.use.cap);
      if (refund > 0) {
        const upd = await client.query(
          'UPDATE economy_accounts SET balance = balance + $3::bigint WHERE guild_id = $1 AND user_id = $2 RETURNING balance',
          [guildId, userId, refund],
        );
        balance = Number(upd.rows[0].balance);
      }
      let bonusTicket = false;
      if (refund > 0 && def.bonus?.onlyIfRefund && randomInt(0, 10000) < Math.round(def.bonus.chance * 10000)) {
        await require('./inventory').addItem(client, guildId, userId, def.bonus.grant, 1);
        bonusTicket = true;
      }
      insurance = { itemId: def.id, name: def.name, chance: def.use.chance, cap: def.use.cap, refund, bonusTicket, usedOnWin: lost <= 0 };
    }

    await client.query(`
      INSERT INTO economy_transactions (guild_id, user_id, amount, balance_after, reason, created_at)
      VALUES ($1, $2, $3::bigint, $4::bigint, $5, $6::bigint)
    `, [guildId, userId, payout - bet + refund, balance, reason, Date.now()]);

    await client.query('COMMIT');
    return { balance, payout: payout + refund, insurance };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    throw err;
  } finally {
    client.release();
  }
}

// Wersja zgodna ze starym kodem: zwraca samo saldo albo null
async function settleBet(guildId, userId, bet, payout, reason) {
  const res = await settleBetEx(guildId, userId, bet, payout, reason);
  return res === null ? null : res.balance;
}

// ------------------------------------------------------------
//  BLOKADA "jedna gra naraz" + przerwa między grami
// ------------------------------------------------------------
const activePlayers = new Set();
const lastFinishedAt = new Map();

// Zwraca { ok: true } albo { ok: false, message }
function tryStartGame(guildId, userId) {
  const key = `${guildId}:${userId}`;
  if (activePlayers.has(key)) {
    return { ok: false, message: '🎰 Poczekaj, aż skończy się Twoja poprzednia gra.' };
  }
  const waitMs = COOLDOWN_MS - (Date.now() - (lastFinishedAt.get(key) ?? 0));
  if (waitMs > 0) {
    return { ok: false, message: `⏳ Zwolnij trochę, Bob ledwo nadąża. Spróbuj za ${Math.ceil(waitMs / 1000)} s.` };
  }
  activePlayers.add(key);
  return { ok: true };
}

function finishGame(guildId, userId) {
  const key = `${guildId}:${userId}`;
  activePlayers.delete(key);
  lastFinishedAt.set(key, Date.now());
}

// ------------------------------------------------------------
//  DOKŁADNY ZWROT DLA GRACZA (RTP) - do testów i do /kasyno zasady
// ------------------------------------------------------------
function slotRtp() {
  let rtp = 0;
  for (const a of SLOT_SYMBOLS) {
    for (const b of SLOT_SYMBOLS) {
      for (const c of SLOT_SYMBOLS) {
        const p = (a.weight / SLOT_TOTAL_WEIGHT) * (b.weight / SLOT_TOTAL_WEIGHT) * (c.weight / SLOT_TOTAL_WEIGHT);
        rtp += p * slotMultiplier(a, b, c).multiplier;
      }
    }
  }
  return rtp;
}

const coinRtp = () => (COIN_WIN_CHANCE_PER_1000 / 1000) * 2;
const rouletteRtp = (kind) => {
  const bet = ROULETTE_BETS[kind];
  const wins = kind === 'numer' ? 1 : Array.from({ length: 37 }, (_, n) => n).filter(bet.test).length;
  return (wins / 37) * bet.multiplier;
};

module.exports = {
  MIN_BET,
  MAX_BET,
  COOLDOWN_MS,
  SLOT_SYMBOLS,
  SLOT_PAIR,
  ROULETTE_BETS,
  flipCoin,
  spinSlots,
  spinRoulette,
  rouletteColor,
  settleBet,
  settleBetEx,
  tryStartGame,
  finishGame,
  slotRtp,
  coinRtp,
  rouletteRtp,
};
