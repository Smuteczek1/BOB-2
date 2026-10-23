const { randomInt } = require('node:crypto');

// ============================================================
//  KATALOG PRZEDMIOTÓW I SKRZYŃ
//  Wszystko, co chcesz zmieniać (nazwy, ceny, szanse, wagi), jest tutaj, w jednym pliku.
//
//  Poziomy (0-6) są takie same jak rzadkości skrzyń dziennych:
//  0 Pospolita, 1 Niezwykła, 2 Rzadka, 3 Legendarna, 4 Mityczna, 5 Boska, 6 Void
//
//  kind:   consumable = jednorazowy | permanent = stały (trudny do zdobycia) | collectible = kolekcjonerski
//  weight: waga w losowaniu W OBRĘBIE swojego poziomu (0 = na razie nie wypada)
//  unique: można mieć tylko jedną sztukę (przy losowaniu pomijany, gdy już go masz)
//  value:  przybliżona wartość w monetach (do ocen "najgorszej skrzyni" i do liczenia cen)
//  bonus:  dodatkowy efekt; uruchamia się raz i NIE wywołuje kolejnych bonusów
// ============================================================

const TIER_NAMES = ['Pospolita', 'Niezwykła', 'Rzadka', 'Legendarna', 'Mityczna', 'Boska', 'Void'];
const TIER_ICONS = ['⚪', '🟢', '🔵', '🟣', '🟠', '🔴', '⚫'];

// Tabele nagród z "pieniężnych" przedmiotów: p = szansa, min/max = zakres wygranej,
// fine = mandat (10% salda, ale nie więcej niż cap i nigdy poniżej zera)
const MONEY = (nothing, a, b, c, fine) => ({
  type: 'money',
  finePct: 10,
  table: [
    { p: nothing },
    { p: a.p, min: a.min, max: a.max },
    { p: b.p, min: b.min, max: b.max },
    { p: fine.p, fine: true, cap: fine.cap },
  ].filter(Boolean),
});

const ITEMS = {
  // ---------------- ⚪ POSPOLITA ----------------
  teczka: {
    id: 'teczka', name: 'Teczka', emoji: '🧾', tier: 0, kind: 'consumable', weight: 1, value: 213,
    desc: 'Znajdziesz w niej nic, trochę monet albo mandat.',
    use: MONEY(0.30, { p: 0.50, min: 150, max: 400 }, { p: 0.12, min: 500, max: 900 }, null, { p: 0.08, cap: 150 }),
    bonus: { chance: 0.10, grant: 'darmowy_los', text: 'darmowy los' },
  },
  darmowy_los: {
    id: 'darmowy_los', name: 'Darmowy los', emoji: '🎟️', tier: 0, kind: 'consumable', weight: 1, value: 100,
    desc: 'Jeden los loterii z losowymi liczbami (liczy się do limitu losów).',
    use: { type: 'ticket', count: 1 },
    bonus: { chance: 0.10, extraTickets: 1, text: 'drugi los gratis' },
  },
  koniczynka: {
    id: 'koniczynka', name: 'Koniczynka', emoji: '🍀', tier: 0, kind: 'consumable', weight: 1, value: 150,
    desc: '+5% szczęścia na 5 minut (rodzina koniczyn).',
    use: { type: 'boost', family: 'koniczyna', value: 5, minutes: 5 },
    bonus: { chance: 0.15, extendMinutes: 10, text: 'działa 10 minut zamiast 5' },
  },

  // ---------------- 🟢 NIEZWYKŁA ----------------
  latarka: {
    id: 'latarka', name: 'Latarka', emoji: '🔦', tier: 1, kind: 'consumable', weight: 1, value: 89,
    desc: 'Przy następnej dziennej skrzyni najgorsza z trzech odpada (i widać, co w niej było).',
    use: { type: 'arm_daily', mode: 'latarka' },
    bonus: { chance: 0.10, grant: 'koniczynka', text: 'Koniczynka' },
  },
  budzik: {
    id: 'budzik', name: 'Budzik Boba', emoji: '⏰', tier: 1, kind: 'consumable', weight: 1, value: 320,
    desc: 'Pozwala odebrać dzienną skrzynię jeszcze raz dzisiaj (z 30% szans na przedmiot zamiast 20%).',
    use: { type: 'budzik' },
  },
  aktowka: {
    id: 'aktowka', name: 'Aktówka', emoji: '👜', tier: 1, kind: 'consumable', weight: 1, value: 548,
    desc: 'Nic, solidna suma albo mandat.',
    use: MONEY(0.25, { p: 0.50, min: 400, max: 900 }, { p: 0.17, min: 1000, max: 1800 }, null, { p: 0.08, cap: 300 }),
    bonus: { chance: 0.10, grant: 'latarka', text: 'Latarka' },
  },
  mala_polisa: {
    id: 'mala_polisa', name: 'Mała polisa', emoji: '🛡️', tier: 1, kind: 'consumable', weight: 1, value: 38,
    desc: 'Na jedną grę w kasynie: po przegranej 30% szans na zwrot straty (do 200).',
    use: { type: 'polisa', chance: 30, cap: 200 },
    bonus: { chance: 0.25, grant: 'darmowy_los', text: 'darmowy los', onlyIfRefund: true },
  },

  // ---------------- 🔵 RZADKA ----------------
  klucz: {
    id: 'klucz', name: 'Zapasowy klucz', emoji: '🗝️', tier: 2, kind: 'consumable', weight: 1, value: 419,
    desc: 'Przy następnej dziennej skrzyni otwierasz też lepszą z dwóch pozostałych.',
    use: { type: 'arm_daily', mode: 'klucz' },
    bonus: { chance: 0.20, grant: 'darmowy_los', text: 'darmowy los' },
  },
  pakiet_losow: {
    id: 'pakiet_losow', name: 'Pakiet losów', emoji: '🎫', tier: 2, kind: 'consumable', weight: 1, value: 500,
    desc: 'Pięć losów loterii naraz (nadwyżka ponad limit wraca jako Darmowe losy).',
    use: { type: 'ticket', count: 5, overflowToItems: true },
    bonus: { chance: 0.15, grant: 'darmowy_los', text: 'dodatkowy darmowy los' },
  },
  walizka: {
    id: 'walizka', name: 'Walizka', emoji: '💼', tier: 2, kind: 'consumable', weight: 1, value: 1542,
    desc: 'Nic, duża suma albo mandat.',
    use: MONEY(0.20, { p: 0.50, min: 1000, max: 2200 }, { p: 0.22, min: 2500, max: 4500 }, null, { p: 0.08, cap: 500 }),
    bonus: { chance: 0.10, grant: 'aktowka', text: 'Aktówka' },
  },
  polisa_boba: {
    id: 'polisa_boba', name: 'Polisa Boba', emoji: '🛡️', tier: 2, kind: 'consumable', weight: 1, value: 170,
    desc: 'Na jedną grę w kasynie: po przegranej 50% szans na zwrot straty (do 500).',
    use: { type: 'polisa', chance: 50, cap: 500 },
    bonus: { chance: 0.25, grant: 'darmowy_los', text: 'darmowy los', onlyIfRefund: true },
  },

  // ---------------- 🟣 LEGENDARNA ----------------
  wielka_polisa: {
    id: 'wielka_polisa', name: 'Wielka polisa', emoji: '🛡️', tier: 3, kind: 'consumable', weight: 1, value: 330,
    desc: 'Na jedną grę w kasynie: po przegranej 50% szans na zwrot straty (do 1 000).',
    use: { type: 'polisa', chance: 50, cap: 1000 },
    bonus: { chance: 0.25, grant: 'darmowy_los', text: 'darmowy los', onlyIfRefund: true },
  },
  sejf: {
    id: 'sejf', name: 'Sejf', emoji: '🗄️', tier: 3, kind: 'consumable', weight: 1, value: 4871,
    desc: 'Nic, bardzo duża suma albo mandat.',
    use: MONEY(0.15, { p: 0.50, min: 3000, max: 6000 }, { p: 0.28, min: 7000, max: 12000 }, null, { p: 0.07, cap: 1000 }),
    bonus: { chance: 0.15, grant: 'klucz', text: 'Zapasowy klucz' },
  },

  // ---------------- 🟠 MITYCZNA ----------------
  koniczyna: {
    id: 'koniczyna', name: 'Koniczyna', emoji: '🍀', tier: 4, kind: 'permanent', unique: true, weight: 20, value: 3000,
    desc: 'STAŁA. Raz dziennie (po północy) daje +5% szczęścia na 5 minut (rodzina koniczyn).',
    use: { type: 'boost_daily', family: 'koniczyna', value: 5, minutes: 5 },
    bonus: { chance: 0.10, extendMinutes: 10, text: 'działa 10 minut zamiast 5' },
  },
  wytrych: {
    id: 'wytrych', name: 'Wytrych', emoji: '🔑', tier: 4, kind: 'consumable', weight: 0, value: 800,
    desc: 'Do napadu. (Napad będzie dostępny wkrótce, wytrych jeszcze nie wypada ze skrzyń.)',
    use: { type: 'none', message: 'Napad jeszcze nie jest dostępny. Zachowaj wytrych na później!' },
  },
  skarbiec: {
    id: 'skarbiec', name: 'Skarbiec', emoji: '🏦', tier: 4, kind: 'consumable', weight: 60, value: 12275,
    desc: 'Nic, ogromna suma albo mandat.',
    use: MONEY(0.15, { p: 0.50, min: 7500, max: 15000 }, { p: 0.28, min: 17500, max: 30000 }, null, { p: 0.07, cap: 2500 }),
    bonus: { chance: 0.10, grant: 'sejf', text: 'Sejf' },
  },

  // ---------------- 🔴 BOSKA ----------------
  podkowa: {
    id: 'podkowa', name: 'Podkowa', emoji: '🐴', tier: 5, kind: 'permanent', unique: true, weight: 20, value: 3000,
    desc: 'STAŁA. Raz dziennie (po północy) +5% szczęścia na 5 minut (rodzina podków). Z Koniczyną sumuje się, a razem dają dodatkowe +2%.',
    use: { type: 'boost_daily', family: 'podkowa', value: 5, minutes: 5 },
  },
  kufer: {
    id: 'kufer', name: 'Kufer Boba', emoji: '🧰', tier: 5, kind: 'consumable', weight: 60, value: 29600,
    desc: 'Nic, gigantyczna suma albo mandat.',
    use: MONEY(0.15, { p: 0.50, min: 18000, max: 36000 }, { p: 0.28, min: 40000, max: 75000 }, null, { p: 0.07, cap: 6000 }),
    bonus: { chance: 0.10, grant: 'skarbiec', text: 'Skarbiec' },
  },
  korona: {
    id: 'korona', name: 'Złota Korona', emoji: '👑', tier: 5, kind: 'collectible', unique: true, weight: 30, value: 2000,
    desc: 'Kolekcjonerska. Tytuł "Koronowany" (bez wpływu na grę).',
    use: { type: 'none', message: 'To przedmiot kolekcjonerski. Nic nie robi, ale świetnie wygląda w ekwipunku.' },
  },

  // ---------------- ⚫ VOID ----------------
  czarna_skrzynka: {
    id: 'czarna_skrzynka', name: 'Czarna Skrzynka', emoji: '🕳️', tier: 6, kind: 'consumable', weight: 70, value: 72950,
    desc: 'Nic, największa suma albo mandat.',
    use: MONEY(0.15, { p: 0.50, min: 45000, max: 90000 }, { p: 0.28, min: 100000, max: 180000 }, null, { p: 0.07, cap: 15000 }),
    bonus: { chance: 0.05, grant: 'kufer', text: 'Kufer Boba' },
  },
  moneta_void: {
    id: 'moneta_void', name: 'Moneta Void', emoji: '⚫', tier: 6, kind: 'collectible', unique: true, weight: 30, value: 5000,
    desc: 'Kolekcjonerska. Unikalna ozdoba (bez wpływu na grę).',
    use: { type: 'none', message: 'To przedmiot kolekcjonerski. Nic nie robi, ale mało kto ją ma.' },
  },
};

// ---------------- SKRZYNIE DO KUPIENIA (SKLEP) ----------------
// Sklep ma 3 skrzynie. Każda ma WIDOCZNĄ listę poziomów rzadkości, które mogą w niej wypaść:
//   tiers = [[poziom, waga], ...]  poziom 0-6 (0 Pospolita ... 6 Void); waga względna = szansa poziomu
//   Konkretny przedmiot jest losowany wśród przedmiotów wylosowanego poziomu (wagi `weight` w ITEMS).
//   Skrzynie mogą się na siebie nakładać (ten sam poziom w dwóch skrzyniach), ale niska nie dostaje wysokich.
//   coins = null (skrzynie ze sklepu nie dają monet), itemChance 1.0 = zawsze wypada przedmiot
//   tier (pojedynczy) = tylko wygląd/komentarz Boba
const CHESTS = {
  chest_braz: {
    id: 'chest_braz', name: 'Skrzynia Brązowa', emoji: '🟤', tier: 1, price: 320,
    coins: null, itemChance: 1.0,
    tiers: [[0, 50], [1, 40], [2, 10]],
  },
  chest_srebrna: {
    id: 'chest_srebrna', name: 'Skrzynia Srebrna', emoji: '⚪', tier: 3, price: 2300,
    coins: null, itemChance: 1.0,
    tiers: [[1, 15], [2, 45], [3, 35], [4, 5]],
  },
  chest_zlota: {
    id: 'chest_zlota', name: 'Skrzynia Złota', emoji: '🟡', tier: 5, price: 21000,
    coins: null, itemChance: 1.0,
    tiers: [[3, 10], [4, 50], [5, 30], [6, 10]],
  },

  // ---- STARE SKRZYNIE (legacy): już niedostępne w sklepie, ale kto je ma w ekwipunku, nadal je otworzy.
  // Gdy nikt już ich nie posiada, możesz usunąć cały ten fragment.
  chest_pospolita:  { id: 'chest_pospolita',  name: 'Skrzynia Pospolita',  emoji: '⚪', legacy: true, tier: 0, price: 360,    coins: [100, 400],     itemChance: 0.15 },
  chest_niezwykla:  { id: 'chest_niezwykla',  name: 'Skrzynia Niezwykła',  emoji: '🟢', legacy: true, tier: 1, price: 900,    coins: [250, 950],     itemChance: 0.35 },
  chest_rzadka:     { id: 'chest_rzadka',     name: 'Skrzynia Rzadka',     emoji: '🔵', legacy: true, tier: 2, price: 2400,   coins: [600, 2400],    itemChance: 0.50 },
  chest_legendarna: { id: 'chest_legendarna', name: 'Skrzynia Legendarna', emoji: '🟣', legacy: true, tier: 3, price: 6900,   coins: [1500, 5500],   itemChance: 0.70 },
  chest_mityczna:   { id: 'chest_mityczna',   name: 'Skrzynia Mityczna',   emoji: '🟠', legacy: true, tier: 4, price: 20000,  coins: [3500, 12500],  itemChance: 0.85 },
  chest_boska:      { id: 'chest_boska',      name: 'Skrzynia Boska',      emoji: '🔴', legacy: true, tier: 5, price: 50000,  coins: [9000, 31000],  itemChance: 1.0 },
  chest_void:       { id: 'chest_void',       name: 'Skrzynia Void',       emoji: '⚫', legacy: true, tier: 6, price: 125000, coins: [22000, 78000], itemChance: 1.0 },
  chest_skrytka:    { id: 'chest_skrytka',    name: 'Skrytka Boba',        emoji: '📦', legacy: true, tier: 2, price: 860,    coins: null,           itemChance: 1.0, itemOnly: true },
};

// Szczęście: rodziny nie sumują się same ze sobą (działa najsilniejsza z rodziny), różne rodziny się sumują.
const LUCK_CAP = 15;
const LUCK_COMBO_BONUS = 2; // gdy aktywne są jednocześnie koniczyna i podkowa

const DAILY_ITEM_CHANCE = 0.20;
const DAILY_ITEM_CHANCE_BUDZIK = 0.30;

// ============================================================
//  LOGIKA (czyste funkcje, bez bazy danych)
// ============================================================

const chance = (p) => randomInt(0, 10000) < Math.round(p * 10000);

function isChest(id) { return Object.prototype.hasOwnProperty.call(CHESTS, id); }
function getDef(id) { return ITEMS[id] ?? CHESTS[id] ?? null; }

function computeLuck(boosts) {
  const byFamily = new Map();
  for (const b of boosts) byFamily.set(b.family, Math.max(byFamily.get(b.family) ?? 0, b.value));
  let sum = 0;
  for (const v of byFamily.values()) sum += v;
  if (byFamily.has('koniczyna') && byFamily.has('podkowa')) sum += LUCK_COMBO_BONUS;
  return Math.min(sum, LUCK_CAP);
}

// Z szansą równą szczęściu losujemy DWA razy i bierzemy lepszy wynik.
function luckyPick(rollFn, scoreFn, luck) {
  const first = rollFn();
  if (luck > 0 && chance(luck / 100)) {
    const second = rollFn();
    return scoreFn(second) > scoreFn(first) ? second : first;
  }
  return first;
}

function weightedPick(entries) {
  const total = entries.reduce((s, e) => s + e.weight, 0);
  if (total <= 0) return null;
  let roll = randomInt(0, total * 1000) / 1000;
  for (const e of entries) {
    if (roll < e.weight) return e;
    roll -= e.weight;
  }
  return entries[entries.length - 1];
}

function pickItemFromTier(tier, owned) {
  const pool = Object.values(ITEMS).filter(
    (i) => i.tier === tier && i.weight > 0 && !(i.unique && owned.has(i.id)),
  );
  return weightedPick(pool);
}

// Poziom wylosowanego przedmiotu względem poziomu skrzyni: 70% ten sam, 25% niższy, 5% wyższy.
function dropItem(baseTier, owned = new Set()) {
  const r = randomInt(0, 100);
  let tier = baseTier;
  if (r >= 70 && r < 95) tier = Math.max(0, baseTier - 1);
  else if (r >= 95) tier = Math.min(TIER_NAMES.length - 1, baseTier + 1);
  const order = [tier, baseTier, baseTier - 1, baseTier + 1, tier - 1, tier + 1];
  for (const t of order) {
    if (t < 0 || t >= TIER_NAMES.length) continue;
    const item = pickItemFromTier(t, owned);
    if (item) return item;
  }
  return null;
}

// Dzienna skrzynia daje przedmioty najwyżej na poziomie Niezwykłym
function dropDailyItem(owned = new Set()) {
  const tier = randomInt(0, 100) < 95 ? 0 : 1;
  return pickItemFromTier(tier, owned) ?? pickItemFromTier(0, owned);
}

// Losowanie przedmiotu ze skrzyni: najpierw poziom (wg wag skrzyni), potem przedmiot z tego poziomu.
// Unikalne, które już masz, są pomijane; gdy poziom się wyczerpie, losujemy z pozostałych poziomów skrzyni.
function pickFromTiers(chest, owned = new Set()) {
  const entries = chest.tiers.map(([tier, weight]) => ({ tier, weight }));
  const first = weightedPick(entries);
  const ordered = first ? [first, ...entries.filter((e) => e !== first)] : entries;
  for (const e of ordered) {
    const item = pickItemFromTier(e.tier, owned);
    if (item) return item;
  }
  return null;
}

// Procentowe szanse poziomów w skrzyni (do wyświetlania w sklepie), od najniższego poziomu
function tierOdds(chest) {
  const total = chest.tiers.reduce((s, [, w]) => s + w, 0);
  return chest.tiers.map(([tier, w]) => ({ tier, pct: (w / total) * 100 })).sort((a, b) => a.tier - b.tier);
}

// Średnia wartość przedmiotu ze skrzyni (do ustalania ceny: sklep ma zwracać ok. 75%)
function expectedItemValue(chest) {
  const total = chest.tiers.reduce((s, [, w]) => s + w, 0);
  let ev = 0;
  for (const [tier, w] of chest.tiers) {
    const pool = Object.values(ITEMS).filter((i) => i.tier === tier && i.weight > 0);
    const tw = pool.reduce((x, i) => x + i.weight, 0);
    if (tw > 0) ev += (w / total) * (pool.reduce((x, i) => x + i.weight * i.value, 0) / tw);
  }
  return ev;
}

// Zawartość jednej skrzyni (kupionej w sklepie)
function rollChestContents(chest, luck = 0, owned = new Set()) {
  const coins = chest.coins
    ? luckyPick(() => randomInt(chest.coins[0], chest.coins[1] + 1), (x) => x, luck)
    : 0;
  const p = Math.min(1, chest.itemChance * (1 + luck / 100));
  let item = null;
  if (chance(p)) {
    // Szczęście: z szansą równą szczęściu losujemy dwa razy i bierzemy cenniejszy przedmiot
    item = chest.tiers
      ? luckyPick(() => pickFromTiers(chest, owned), (it) => (it ? it.value : 0), luck)
      : dropItem(chest.tier, owned);
  }
  return { coins, item };
}

// Jedna próba "pieniężnego" przedmiotu: nic / wygrana / mandat
function rollMoneyOnce(use, balance) {
  const roll = randomInt(0, 1000);
  let acc = 0;
  for (const e of use.table) {
    acc += Math.round(e.p * 1000);
    if (roll < acc) {
      if (e.fine) return { kind: 'fine', amount: Math.max(0, Math.min(Math.floor((balance * use.finePct) / 100), e.cap)) };
      if (e.min === undefined) return { kind: 'nothing', amount: 0 };
      return { kind: 'gain', amount: randomInt(e.min, e.max + 1) };
    }
  }
  return { kind: 'nothing', amount: 0 };
}

const moneyScore = (o) => (o.kind === 'gain' ? o.amount : o.kind === 'fine' ? -o.amount : 0);

function rollMoney(use, balance, luck = 0) {
  return luckyPick(() => rollMoneyOnce(use, balance), moneyScore, luck);
}

// Data kalendarzowa w Polsce (YYYY-MM-DD), do limitu "raz dziennie"
const WARSAW_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' });
function warsawDate(ms = Date.now()) { return WARSAW_DATE.format(new Date(ms)); }

module.exports = {
  TIER_NAMES, TIER_ICONS, ITEMS, CHESTS,
  LUCK_CAP, LUCK_COMBO_BONUS, DAILY_ITEM_CHANCE, DAILY_ITEM_CHANCE_BUDZIK,
  chance, isChest, getDef, computeLuck, luckyPick, dropItem, dropDailyItem,
  rollChestContents, pickFromTiers, tierOdds, expectedItemValue, rollMoneyOnce, rollMoney, moneyScore, warsawDate,
};
