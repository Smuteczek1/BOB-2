const { randomInt: cryptoRandomInt } = require('node:crypto');

// ============================================================
//  KONFIGURACJA WALUTY - zmieniasz tutaj, w jednym miejscu
// ============================================================
const CURRENCY = {
  emoji: '🪙',
  // formy liczby: 1 / 2-4 / 5+  (np. "1 moneta", "2 monety", "5 monet")
  forms: ['moneta', 'monety', 'monet'],
};

// Skrzynie dziennej nagrody. chance = szansa w promilach (suma musi dać 1000).
const DAILY_TIERS = [
  { name: '⚪ Pospolita Skrzynia', color: 0x95a5a6, chance: 350, min: 50, max: 100 },
  { name: '🟢 Niezwykła Skrzynia', color: 0x2ecc71, chance: 280, min: 101, max: 200 },
  { name: '🔵 Rzadka Skrzynia', color: 0x3498db, chance: 190, min: 201, max: 350 },
  { name: '🟣 Legendarna Skrzynia', color: 0x9b59b6, chance: 100, min: 351, max: 600 },
  { name: '🟠 Mityczna Skrzynia!', color: 0xe67e22, chance: 55, min: 601, max: 1200 },
  { name: '🔴 Boska Skrzynia!!', color: 0xe74c3c, chance: 20, min: 1201, max: 2200 },
  { name: '⚫ VOID SKRZYNIA!!!', color: 0x1a1a2e, chance: 5, min: 3000, max: 6000 },
];

// Czytelne nazwy powodów transakcji w /portfel
const REASON_LABELS = {
  daily: 'Dzienna skrzynia',
  casino_automat: 'Kasyno: automat',
  casino_ruletka: 'Kasyno: ruletka',
  casino_moneta: 'Kasyno: orzeł/reszka',
  lotto_ticket: 'Lotto: los',
  lotto_win: 'Lotto: wygrana',
  chest_open: 'Otwarcie skrzyni',
  mandat: 'Mandat',
  reset: 'Reset salda',
};

// ============================================================

function pluralPl(n, forms) {
  const abs = Math.abs(n);
  if (abs === 1) return forms[0];
  const lastTwo = abs % 100;
  const last = abs % 10;
  if (last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14)) return forms[1];
  return forms[2];
}

// np. "🪙 **1 250** monet"
function formatCoins(amount) {
  const n = Number(amount);
  return `${CURRENCY.emoji} **${n.toLocaleString('pl-PL')}** ${pluralPl(n, CURRENCY.forms)}`;
}

// Losowanie liczb całkowitych z kryptograficznego RNG (min i max włącznie).
// Do gier i nagród używamy tego, a nie Math.random().
function secureInt(min, max) {
  return cryptoRandomInt(min, max + 1);
}

function rollDailyReward() {
  const roll = cryptoRandomInt(0, 1000);
  let threshold = 0;
  for (const tier of DAILY_TIERS) {
    threshold += tier.chance;
    if (roll < threshold) {
      return { tier, amount: secureInt(tier.min, tier.max) };
    }
  }
  const last = DAILY_TIERS[DAILY_TIERS.length - 1];
  return { tier: last, amount: secureInt(last.min, last.max) };
}

function reasonLabel(reason) {
  if (REASON_LABELS[reason]) return REASON_LABELS[reason];
  // Powody tworzone dynamicznie przez sklep i przedmioty (wczytywane leniwie, żeby uniknąć pętli importów)
  try {
    const { ITEMS, CHESTS } = require('./items');
    if (reason.startsWith('shop_') && CHESTS[reason.slice(5)]) return `Sklep: ${CHESTS[reason.slice(5)].name}`;
    if (reason.startsWith('item_') && ITEMS[reason.slice(5)]) return `Przedmiot: ${ITEMS[reason.slice(5)].name}`;
  } catch { /* brak katalogu: pokaż surowy powód */ }
  return reason;
}

module.exports = {
  CURRENCY,
  DAILY_TIERS,
  pluralPl,
  formatCoins,
  secureInt,
  rollDailyReward,
  reasonLabel,
};
