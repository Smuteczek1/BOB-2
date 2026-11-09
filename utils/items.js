const { randomInt } = require('node:crypto');
const { DAILY_TIERS } = require('./economy');
const jobsCfg = require('./jobs');

// Stałe przedmioty "ekonomiczne" (poziom = ilość w ekwipunku, max 5)
const PERKS = {
  SLOTS_PER_LEVEL: 1, // Magazyn: +ofert na rynku za poziom
  FEE_STEP: 0.004, // Magazyn: o tyle mniejsza prowizja rynku za poziom (5% -> 3% na 5. poziomie)
  DAILY_ITEM_PER_LEVEL: 0.02, // Wschód słońca: +szansy na przedmiot w dziennej skrzyni za poziom
  INTEREST_PCT_PER_LEVEL: 0.2, // Skarbonka: % salda dziennie za poziom
  INTEREST_CAP_PER_LEVEL: 400, // Skarbonka: limit odsetek dziennie za poziom
  INTEREST_MAX_DAYS: 3, // za ile zaległych dni naraz można odebrać odsetki
};

// ============================================================
//  KATALOG PRZEDMIOTÓW I SKRZYŃ
//  Wszystko, co chcesz zmieniać (nazwy, ceny, szanse, wagi), jest tutaj, w jednym pliku.
//
//  Poziomy (0-6) są takie same jak rzadkości skrzyń dziennych:
//  0 Pospolita, 1 Niezwykła, 2 Rzadka, 3 Legendarna, 4 Mityczna, 5 Boska, 6 Void
//
//  kind:     consumable = jednorazowy | permanent = stały (trudny do zdobycie) | collectible = kolekcjonerski
//  weight:   waga w losowaniu W OBRĘBIE swojego poziomu (0 = na razie nie wypada)
//  unique:   można mieć tylko jedną sztukę (przy losowaniu pomijany, gdy już go masz)
//  maxLevel: (tylko z unique) kolejne sztuki podnoszą POZIOM przedmiotu (ilość w ekwipunku = poziom);
//            po osiągnięciu maksymalnego poziomu przedmiot przestaje wypadać
//  value:    przybliżona wartość w monetach (do ocen "najgorszej skrzyni" i do liczenia cen)
//  bonus:    dodatkowy efekt; uruchamia się raz i NIE wywołuje kolejnych bonusów
// ============================================================

const TIER_NAMES = ['Pospolita', 'Niezwykła', 'Rzadka', 'Legendarna', 'Mityczna', 'Boska', 'Void'];
const TIER_ICONS = ['⚪', '🟢', '🔵', '🟣', '🟠', '🔴', '⚫'];
const MAX_TIER = TIER_NAMES.length - 1;

// ============================================================
//  SZCZĘŚCIE I PECH (wszystkie wartości do zmiany są tutaj)
//
//  Szczęście stałe: Koniczyna i Podkowa działają ZAWSZE. Ich poziom (ilość w ekwipunku, max MAX_LEVEL)
//  daje LEVEL_BONUS[poziom] % szczęścia. Poziomy się nie sumują (liczy się obecny poziom).
//  Gdy masz obie, dochodzi COMBO_BONUS %. Koniczynka (jednorazowa) daje ONCE_BONUS % na jedną skrzynię
//  i sumuje się ze stałymi.
//  Pech: licznik 0..1 (osobny dla każdego rodzaju skrzyni) rośnie po słabych losowaniach i daje do PITY_MAX %.
//  Szczęście + pech razem nie przekroczą LUCK_CAP %.
// ============================================================
const MAX_LEVEL = 5;
const LEVEL_BONUS = [0, 2, 4, 6, 8, 10];
const COMBO_BONUS = 4;
const ONCE_BONUS = 10;
const LUCK_CAP = 30;
const PITY_MAX = 10;
const PITY_THRESHOLD = 0.4; // wynik poniżej 40. percentyla danej skrzyni to "słabe losowanie"
const PITY_STEP = 1.0;      // jak mocno jedno losowanie rusza licznik pecha

// Siła losowania: liczba 0-100 (+ bonus), z możliwością "przebicia" do STRENGTH.cap.
//   crit:      szansa na losowe dodatkowe 0..critMax punktów siły
//   upPerPoint: szansa na awans poziomu za każdy punkt siły ponad 100
//   tierShift: szansa na awans poziomu za każdy punkt bonusu
const STRENGTH = { crit: 0.03, critMax: 30, cap: 130, upPerPoint: 0.02, tierShift: 0.01 };

// Przelicznik szczęścia: ile punktów siły daje 1% bonusu w danej skrzyni.
// Tanie skrzynie mocniej reagują na siłę (przedmioty w poziomie bardzo różnią się wartością), więc mają niższy mnożnik.
// Dobrane symulacją tak, by przy maksymalnym szczęściu (LUCK_CAP) zwrot ze sklepu wynosił ok. 100%
// (z uwzględnieniem tego, że przedmioty pieniężne ze skrzyń też dostają bonus: klucz 'money').
// Po zmianie ceny, wag, poziomów albo wartości przedmiotów warto te liczby przeliczyć ponownie.
const CHEST_SCALE = { daily: 1, chest_braz: 0.18, chest_srebrna: 0.17, chest_zlota: 0.6, money: 0.15 };

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
    desc: `+${ONCE_BONUS}% szczęścia na następną skrzynię (dzienną albo ze sklepu). Sumuje się ze stałymi.`,
    use: { type: 'arm_luck', bonus: ONCE_BONUS },
  },
  kawa: {
    id: 'kawa', name: 'Kawa', emoji: '☕', tier: 0, kind: 'consumable', weight: 0.3, value: 60,
    desc: 'Do pracy: +15 energii (nie więcej niż maksimum).',
    use: { type: 'work_energy', amount: 15 },
  },
  przekaska: {
    id: 'przekaska', name: 'Przekąska', emoji: '🥪', tier: 0, kind: 'consumable', weight: 0.3, value: 45,
    desc: 'Do pracy: +10 energii (nie więcej niż maksimum).',
    use: { type: 'work_energy', amount: 10 },
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
  energetyk: {
    id: 'energetyk', name: 'Energetyk', emoji: '🥤', tier: 1, kind: 'consumable', weight: 0.3, value: 150,
    desc: 'Do pracy: +30 energii (nie więcej niż maksimum).',
    use: { type: 'work_energy', amount: 30 },
  },
  karta_przerwy: {
    id: 'karta_przerwy', name: 'Karta przerwy', emoji: '🪪', tier: 1, kind: 'consumable', weight: 0.3, value: 90,
    desc: 'Do pracy: kończy przerwę między zadaniami, więc możesz od razu zagrać kolejną mini-grę.',
    use: { type: 'work_reset' },
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
  premia: {
    id: 'premia', name: 'Premia', emoji: '💵', tier: 2, kind: 'consumable', weight: 0.3, value: 260,
    desc: 'Do pracy: następna zmiana albo zadanie daje +50% monet.',
    use: { type: 'work_boost', pay: 50 },
  },
  szkolenie: {
    id: 'szkolenie', name: 'Szkolenie', emoji: '🎓', tier: 2, kind: 'consumable', weight: 0.3, value: 240,
    desc: 'Do pracy: następna zmiana albo zadanie daje +50% XP.',
    use: { type: 'work_boost', xp: 50 },
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
  mega_energetyk: {
    id: 'mega_energetyk', name: 'Mega energetyk', emoji: '⚡', tier: 3, kind: 'consumable', weight: 0.3, value: 600,
    desc: 'Do pracy: +60 energii (nie więcej niż maksimum).',
    use: { type: 'work_energy', amount: 60 },
  },

  // ---------------- 🟠 MITYCZNA ----------------
  koniczyna: {
    id: 'koniczyna', name: 'Koniczyna', emoji: '🍀', tier: 4, kind: 'permanent', unique: true, maxLevel: MAX_LEVEL, luckFamily: 'koniczyna', weight: 20, value: 3000,
    desc: `STAŁA, działa zawsze. Kolejne sztuki podnoszą jej poziom (max ${MAX_LEVEL}): szczęście od +${LEVEL_BONUS[1]}% do +${LEVEL_BONUS[MAX_LEVEL]}%.`,
    use: { type: 'none', message: 'Koniczyna działa sama, nie trzeba jej używać. Kolejne sztuki ze skrzyń podnoszą jej poziom.' },
  },
  krzeslo: {
    id: 'krzeslo', name: 'Ergonomiczne krzesło', emoji: '🪑', tier: 4, kind: 'permanent', unique: true, maxLevel: MAX_LEVEL, workFamily: 'chair', weight: 10, value: 3000,
    desc: `STAŁE, działa zawsze. Kolejne sztuki podnoszą poziom (max ${MAX_LEVEL}): +${jobsCfg.CHAIR_PER_LEVEL} do maksymalnej energii w pracy za poziom.`,
    use: { type: 'none', message: 'Krzesło działa samo (+max energii w pracy). Kolejne sztuki ze skrzyń podnoszą jego poziom.' },
  },
  zegarek: {
    id: 'zegarek', name: 'Zegarek szefa', emoji: '⏱️', tier: 4, kind: 'permanent', unique: true, maxLevel: MAX_LEVEL, workFamily: 'clock', weight: 6, value: 4000,
    desc: `STAŁY, działa zawsze. Kolejne sztuki podnoszą poziom (max ${MAX_LEVEL}): przerwa między zadaniami w pracy krótsza o ${jobsCfg.CLOCK_PER_LEVEL} min za poziom.`,
    use: { type: 'none', message: 'Zegarek działa sam (krótsza przerwa między zadaniami). Kolejne sztuki ze skrzyń podnoszą jego poziom.' },
  },
  powerbank: {
    id: 'powerbank', name: 'Powerbank', emoji: '🔋', tier: 4, kind: 'permanent', unique: true, maxLevel: MAX_LEVEL, workFamily: 'battery', weight: 6, value: 4000,
    desc: `STAŁY, działa zawsze. Kolejne sztuki podnoszą poziom (max ${MAX_LEVEL}): Kawa, Energetyk i inne dają o ${jobsCfg.BATTERY_PER_LEVEL}% więcej energii za poziom.`,
    use: { type: 'none', message: 'Powerbank działa sam (więcej energii z napojów). Kolejne sztuki ze skrzyń podnoszą jego poziom.' },
  },
  magazyn: {
    id: 'magazyn', name: 'Magazyn', emoji: '📦', tier: 4, kind: 'permanent', unique: true, maxLevel: MAX_LEVEL, weight: 6, value: 4000,
    desc: `STAŁY, działa zawsze. Kolejne sztuki podnoszą poziom (max ${MAX_LEVEL}): +${PERKS.SLOTS_PER_LEVEL} oferta na rynku i prowizja niższa o ${PERKS.FEE_STEP * 100}% za poziom (do 3%).`,
    use: { type: 'none', message: 'Magazyn działa sam (więcej ofert i niższa prowizja na rynku). Kolejne sztuki ze skrzyń podnoszą jego poziom.' },
  },
  wschod: {
    id: 'wschod', name: 'Wschód słońca', emoji: '🌅', tier: 4, kind: 'permanent', unique: true, maxLevel: MAX_LEVEL, weight: 6, value: 4000,
    desc: `STAŁY, działa zawsze. Kolejne sztuki podnoszą poziom (max ${MAX_LEVEL}): +${PERKS.DAILY_ITEM_PER_LEVEL * 100}% szansy na przedmiot w dziennej skrzyni za poziom.`,
    use: { type: 'none', message: 'Wschód słońca działa sam (większa szansa na przedmiot w dziennej skrzyni). Kolejne sztuki ze skrzyń podnoszą jego poziom.' },
  },

  wytrych: {
    id: 'wytrych', name: 'Wytrych', emoji: '🔑', tier: 2, kind: 'consumable', weight: 0.4, value: 1200,
    desc: 'Do napadów: zużywa się przy starcie napadu, który go wymaga (`/napad`).',
    use: { type: 'none', message: 'Wytrych zużyje się sam, gdy zaczniesz napad, który go wymaga. Zobacz /napad.' },
  },
  lom: {
    id: 'lom', name: 'Łom', emoji: '🔩', tier: 1, kind: 'consumable', weight: 0.4, value: 400,
    desc: 'Do napadów: zużywa się przy starcie napadu, który go wymaga (`/napad`).',
    use: { type: 'none', message: 'Łom zużyje się sam, gdy zaczniesz napad, który go wymaga. Zobacz /napad.' },
  },
  krotkofalowka: {
    id: 'krotkofalowka', name: 'Krótkofalówka', emoji: '📻', tier: 1, kind: 'consumable', weight: 0.4, value: 500,
    desc: 'Do napadów: zużywa się przy starcie napadu, który go wymaga (`/napad`).',
    use: { type: 'none', message: 'Krótkofalówka zużyje się sam, gdy zaczniesz napad, który go wymaga. Zobacz /napad.' },
  },
  mapa: {
    id: 'mapa', name: 'Mapa', emoji: '🗺️', tier: 2, kind: 'consumable', weight: 0.4, value: 800,
    desc: 'Do napadów: zużywa się przy starcie napadu, który go wymaga (`/napad`).',
    use: { type: 'none', message: 'Mapa zużyje się sam, gdy zaczniesz napad, który go wymaga. Zobacz /napad.' },
  },
  przebranie: {
    id: 'przebranie', name: 'Przebranie', emoji: '🎭', tier: 3, kind: 'consumable', weight: 0.4, value: 1500,
    desc: 'Do napadów: zużywa się przy starcie napadu, który go wymaga (`/napad`).',
    use: { type: 'none', message: 'Przebranie zużyje się sam, gdy zaczniesz napad, który go wymaga. Zobacz /napad.' },
  },
  skarbiec: {
    id: 'skarbiec', name: 'Skarbiec', emoji: '🏦', tier: 4, kind: 'consumable', weight: 60, value: 12275,
    desc: 'Nic, ogromna suma albo mandat.',
    use: MONEY(0.15, { p: 0.50, min: 7500, max: 15000 }, { p: 0.28, min: 17500, max: 30000 }, null, { p: 0.07, cap: 2500 }),
    bonus: { chance: 0.10, grant: 'sejf', text: 'Sejf' },
  },

  // ---------------- 🔴 BOSKA ----------------
  podkowa: {
    id: 'podkowa', name: 'Podkowa', emoji: '🐴', tier: 5, kind: 'permanent', unique: true, maxLevel: MAX_LEVEL, luckFamily: 'podkowa', weight: 20, value: 3000,
    desc: `STAŁA, działa zawsze. Kolejne sztuki podnoszą jej poziom (max ${MAX_LEVEL}): szczęście od +${LEVEL_BONUS[1]}% do +${LEVEL_BONUS[MAX_LEVEL]}%. Z Koniczyną dają dodatkowe +${COMBO_BONUS}%.`,
    use: { type: 'none', message: 'Podkowa działa sama, nie trzeba jej używać. Kolejne sztuki ze skrzyń podnoszą jej poziom.' },
  },
  ekspres: {
    id: 'ekspres', name: 'Ekspres do kawy', emoji: '🫖', tier: 5, kind: 'permanent', unique: true, maxLevel: MAX_LEVEL, workFamily: 'espresso', weight: 10, value: 3000,
    desc: `STAŁY, działa zawsze. Kolejne sztuki podnoszą poziom (max ${MAX_LEVEL}): +${jobsCfg.ESPRESSO_PER_LEVEL} energii na godzinę w pracy za poziom.`,
    use: { type: 'none', message: 'Ekspres działa sam (+regeneracja energii w pracy). Kolejne sztuki ze skrzyń podnoszą jego poziom.' },
  },
  notes: {
    id: 'notes', name: 'Notes mistrza', emoji: '🧠', tier: 5, kind: 'permanent', unique: true, maxLevel: MAX_LEVEL, workFamily: 'xp', weight: 6, value: 4000,
    desc: `STAŁY, działa zawsze. Kolejne sztuki podnoszą poziom (max ${MAX_LEVEL}): +${jobsCfg.XP_PER_LEVEL}% XP z pracy za poziom.`,
    use: { type: 'none', message: 'Notes działa sam (więcej XP z pracy). Kolejne sztuki ze skrzyń podnoszą jego poziom.' },
  },
  zlota_teczka: {
    id: 'zlota_teczka', name: 'Złota teczka', emoji: '💼', tier: 5, kind: 'permanent', unique: true, maxLevel: MAX_LEVEL, workFamily: 'pay', weight: 6, value: 4000,
    desc: `STAŁA, działa zawsze. Kolejne sztuki podnoszą poziom (max ${MAX_LEVEL}): +${jobsCfg.PAY_PER_LEVEL}% monet z pracy za poziom.`,
    use: { type: 'none', message: 'Teczka działa sama (więcej monet z pracy). Kolejne sztuki ze skrzyń podnoszą jej poziom.' },
  },
  dyplom: {
    id: 'dyplom', name: 'Dyplom awansu', emoji: '🏆', tier: 5, kind: 'permanent', unique: true, maxLevel: MAX_LEVEL, workFamily: 'promo', weight: 6, value: 4000,
    desc: `STAŁY, działa zawsze. Kolejne sztuki podnoszą poziom (max ${MAX_LEVEL}): awans w pracy po ${jobsCfg.PROMO_PER_LEVEL}% mniejszej liczbie zmian za poziom.`,
    use: { type: 'none', message: 'Dyplom działa sam (szybsze awanse w pracy). Kolejne sztuki ze skrzyń podnoszą jego poziom.' },
  },
  skarbonka: {
    id: 'skarbonka', name: 'Skarbonka', emoji: '🐷', tier: 5, kind: 'permanent', unique: true, maxLevel: MAX_LEVEL, weight: 6, value: 6000,
    desc: `STAŁA, działa zawsze. Kolejne sztuki podnoszą poziom (max ${MAX_LEVEL}): odsetki ${PERKS.INTEREST_PCT_PER_LEVEL}% salda dziennie za poziom (do ${PERKS.INTEREST_CAP_PER_LEVEL} 🪙 za poziom na dzień). Naliczane przy otwarciu /portfel, do ${PERKS.INTEREST_MAX_DAYS} dni wstecz.`,
    use: { type: 'none', message: 'Skarbonka działa sama (odsetki od salda). Sprawdź /portfel, żeby je odebrać. Kolejne sztuki ze skrzyń podnoszą jej poziom.' },
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
//   Szczęście i pech podnoszą "siłę losowania" i dają szansę na awans poziomu (patrz STRENGTH).
//   Skrzynie mogą się na siebie nakładać (ten sam poziom w dwóch skrzyniach), ale niska nie dostaje wysokich
//   (wysokie poziomy wypadają w niskiej skrzyni tylko dzięki awansowi z szczęścia/przebicia).
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

const LUCK_COMBO_BONUS = COMBO_BONUS; // zgodność ze starą nazwą

const DAILY_ITEM_CHANCE = 0.20;
const DAILY_ITEM_CHANCE_BUDZIK = 0.30;

// ============================================================
//  LOGIKA (czyste funkcje, bez bazy danych)
// ============================================================

// Losowość: domyślnie kryptograficzna. Tylko do obliczania statystyk (progi pecha, szanse w sklepie)
// podmieniamy ją na Math.random przez withRng.
let rnd = () => randomInt(0, 1_000_000_000) / 1_000_000_000;
function withRng(gen, fn) {
  const prev = rnd;
  rnd = gen;
  try { return fn(); } finally { rnd = prev; }
}

const chance = (p) => randomInt(0, 10000) < Math.round(p * 10000);

function isChest(id) { return Object.prototype.hasOwnProperty.call(CHESTS, id); }
function getDef(id) { return ITEMS[id] ?? CHESTS[id] ?? null; }

// ---------------- SZCZĘŚCIE I PECH ----------------
const clampLevel = (n) => Math.max(0, Math.min(MAX_LEVEL, Math.floor(Number(n)) || 0));
const clamp01 = (x) => Math.min(1, Math.max(0, Number(x) || 0));

// Szczęście z posiadanych przedmiotów: { koniczyna, podkowa } to poziomy (0 = brak), once = czy jest włączona Koniczynka.
function luckBreakdown({ koniczyna = 0, podkowa = 0, once = false } = {}) {
  const kLvl = clampLevel(koniczyna);
  const pLvl = clampLevel(podkowa);
  const k = LEVEL_BONUS[kLvl];
  const p = LEVEL_BONUS[pLvl];
  const combo = kLvl > 0 && pLvl > 0 ? COMBO_BONUS : 0;
  const oneTime = once ? ONCE_BONUS : 0;
  const raw = k + p + combo + oneTime;
  return { koniczynaLevel: kLvl, podkowaLevel: pLvl, koniczyna: k, podkowa: p, combo, once: oneTime, raw, luck: Math.min(LUCK_CAP, raw) };
}

const pityBonus = (meter) => PITY_MAX * clamp01(meter);

// Całkowity bonus (w %): szczęście + pech, ze wspólnym limitem
function totalBonus(luck, pityMeter = 0) {
  return Math.min(LUCK_CAP, luck + pityBonus(pityMeter));
}

// ---------------- SIŁA LOSOWANIA ----------------
// Siła: 0-100 (+ punkty z bonusu), z rzadkim "przebiciem" ponad 100 (maks. STRENGTH.cap).
function strength(points) {
  let s = rnd() * 100 + points;
  if (rnd() < STRENGTH.crit) s += rnd() * STRENGTH.critMax;
  return Math.min(s, STRENGTH.cap);
}

// Awans poziomu: z bonusu (STRENGTH.tierShift za punkt) oraz z przebicia ponad 100 (STRENGTH.upPerPoint za punkt)
function promote(tier, s, points, maxTier = MAX_TIER) {
  let t = tier;
  if (t < maxTier && points > 0 && rnd() < points * STRENGTH.tierShift) t += 1;
  if (s > 100 && t < maxTier && rnd() < (s - 100) * STRENGTH.upPerPoint) t += 1;
  return t;
}

function weightedPick(entries) {
  const total = entries.reduce((s, e) => s + e.weight, 0);
  if (total <= 0) return null;
  let roll = rnd() * total;
  for (const e of entries) {
    if (roll < e.weight) return e;
    roll -= e.weight;
  }
  return entries[entries.length - 1];
}

// Wybór wg pozycji 0..1: lista posortowana od najsłabszego, każdy przedmiot zajmuje odcinek proporcjonalny do wagi
function pickByPosition(list, pos) {
  const total = list.reduce((s, e) => s + e.weight, 0);
  let x = Math.min(Math.max(pos, 0), 0.999999) * total;
  for (const e of list) {
    if (x < e.weight) return e;
    x -= e.weight;
  }
  return list[list.length - 1];
}

// Przedmiot z poziomu wg siły. Unikalne (stałe i kolekcjonerskie) mają stałą szansę poza siłą,
// pozostałe są uporządkowane od najsłabszego (wg value), a siła wybiera, który wypadnie.
function itemFromTier(tier, s, owned = new Set()) {
  const all = Object.values(ITEMS).filter(
    (i) => i.tier === tier && i.weight > 0 && !(i.unique && owned.has(i.id)),
  );
  if (all.length === 0) return null;
  const uniq = all.filter((i) => i.unique);
  const norm = all.filter((i) => !i.unique).sort((a, b) => a.value - b.value);
  if (uniq.length > 0) {
    const total = all.reduce((x, i) => x + i.weight, 0);
    const share = uniq.reduce((x, i) => x + i.weight, 0) / total;
    if (norm.length === 0 || rnd() < share) return weightedPick(uniq);
  }
  return pickByPosition(norm, Math.min(s, 100) / 100);
}

// Gdy w poziomie nic nie zostało (np. same unikaty, które już masz), szukamy w sąsiednich poziomach
function itemNearTier(tier, s, owned = new Set()) {
  for (const off of [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6]) {
    const t = tier + off;
    if (t < 0 || t > MAX_TIER) continue;
    const item = itemFromTier(t, s, owned);
    if (item) return item;
  }
  return null;
}

// Jedna dzienna skrzynia: { tier, tierIndex, amount, item, strength }
function rollDailyChest(bonusPct = 0, owned = new Set(), baseItemChance = DAILY_ITEM_CHANCE) {
  const points = bonusPct * CHEST_SCALE.daily;
  const r = Math.floor(rnd() * 1000);
  let acc = 0;
  let base = DAILY_TIERS.length - 1;
  for (let i = 0; i < DAILY_TIERS.length; i += 1) {
    acc += DAILY_TIERS[i].chance;
    if (r < acc) { base = i; break; }
  }
  const s = strength(points);
  const tierIndex = promote(base, s, points, DAILY_TIERS.length - 1);
  const tier = DAILY_TIERS[tierIndex];
  const amount = Math.round(tier.min + (tier.max - tier.min) * (s / 100)); // ponad 100 kwota rośnie dalej

  let item = null;
  if (rnd() < Math.min(1, baseItemChance * (1 + points / 100))) {
    // Dzienna daje przedmioty najwyżej na poziomie Niezwykłym (siła 95+ = poziom 1)
    item = s < 95 ? itemFromTier(0, (s / 95) * 100, owned) : itemFromTier(1, ((s - 95) / 5) * 100, owned);
    if (!item) item = itemNearTier(0, s, owned);
  }
  return { tier, tierIndex, amount, item, strength: s };
}

// Jedna skrzynia ze sklepu: { item, tier, strength }
function rollShopChest(chest, bonusPct = 0, owned = new Set()) {
  const points = bonusPct * (CHEST_SCALE[chest.id] ?? 1);
  const base = weightedPick(chest.tiers.map(([tier, weight]) => ({ tier, weight }))).tier;
  const s = strength(points);
  const tier = promote(base, s, points, MAX_TIER);
  const item = itemNearTier(tier, s, owned);
  return { item, tier, strength: s };
}

// ---------------- STARE FUNKCJE (legacy i zgodność) ----------------
// Z szansą równą szczęściu losujemy DWA razy i bierzemy lepszy wynik. Używane tylko przez stare skrzynie.
function luckyPick(rollFn, scoreFn, luck) {
  const first = rollFn();
  if (luck > 0 && chance(luck / 100)) {
    const second = rollFn();
    return scoreFn(second) > scoreFn(first) ? second : first;
  }
  return first;
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

// Stara dzienna: przedmioty najwyżej na poziomie Niezwykłym (nowa dzienna: rollDailyChest)
function dropDailyItem(owned = new Set()) {
  const tier = randomInt(0, 100) < 95 ? 0 : 1;
  return pickItemFromTier(tier, owned) ?? pickItemFromTier(0, owned);
}

// Procentowe szanse poziomów w skrzyni (do wyświetlania w sklepie), od najniższego poziomu
function tierOdds(chest) {
  const total = chest.tiers.reduce((s, [, w]) => s + w, 0);
  return chest.tiers.map(([tier, w]) => ({ tier, pct: (w / total) * 100 })).sort((a, b) => a.tier - b.tier);
}

// Szanse poziomów z uwzględnieniem bonusu gracza (szczęście + pech), liczone na próbce tej samej funkcji,
// która losuje naprawdę. Wynik jest zapamiętany (zaokrąglony do 0,5% bonusu).
const oddsCache = new Map();
function effectiveTierOdds(chest, bonusPct, n = 30000) {
  const bonus = Math.round(Math.max(0, bonusPct) * 2) / 2;
  if (bonus === 0) return tierOdds(chest);
  const key = `${chest.id}:${bonus}`;
  if (oddsCache.has(key)) return oddsCache.get(key);
  const counts = new Array(TIER_NAMES.length).fill(0);
  withRng(Math.random, () => {
    for (let i = 0; i < n; i += 1) counts[rollShopChest(chest, bonus, new Set()).tier] += 1;
  });
  const odds = counts.map((c, tier) => ({ tier, pct: (c / n) * 100 })).filter((o) => o.pct > 0);
  if (oddsCache.size > 500) oddsCache.clear();
  oddsCache.set(key, odds);
  return odds;
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

// Zawartość jednej skrzyni: { coins, item }. bonusPct = szczęście + pech (w %).
function rollChestContents(chest, bonusPct = 0, owned = new Set()) {
  if (chest.tiers) {
    return { coins: 0, item: rollShopChest(chest, bonusPct, owned).item };
  }
  // Stare skrzynie (legacy): jak dawniej
  const luck = Math.min(100, bonusPct);
  const coins = chest.coins
    ? luckyPick(() => randomInt(chest.coins[0], chest.coins[1] + 1), (x) => x, luck)
    : 0;
  const p = Math.min(1, chest.itemChance * (1 + luck / 100));
  const item = chance(p) ? dropItem(chest.tier, owned) : null;
  return { coins, item };
}

// ---------------- PRZEDMIOTY "PIENIĘŻNE" ----------------
// Stara jedna próba: nic / wygrana / mandat (bez szczęścia)
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

// Wynik uporządkowany od najgorszego: mandat, nic, wygrane od najmniejszej. Siła wybiera miejsce na tej skali,
// więc szczęście przesuwa szanse z mandatu i "nic" w stronę wygranych. Przy bonusie 0 szanse są takie same jak w tabeli.
function rollMoney(use, balance, bonusPct = 0) {
  const points = bonusPct * CHEST_SCALE.money;
  const s = strength(points);
  const pos = Math.min(s, 100) / 100;

  const fine = use.table.find((e) => e.fine);
  const nothing = use.table.find((e) => !e.fine && e.min === undefined);
  const gains = use.table.filter((e) => e.min !== undefined).sort((a, b) => a.min - b.min);
  const ordered = [fine, nothing, ...gains].filter(Boolean);

  let acc = 0;
  for (let i = 0; i < ordered.length; i += 1) {
    const e = ordered[i];
    if (pos < acc + e.p || i === ordered.length - 1) {
      if (e.fine) return { kind: 'fine', amount: Math.max(0, Math.min(Math.floor((balance * use.finePct) / 100), e.cap)) };
      if (e.min === undefined) return { kind: 'nothing', amount: 0 };
      const f = Math.min(1, Math.max(0, (pos - acc) / e.p));
      let amount = e.min + (e.max - e.min) * f;
      if (s > 100) amount *= 1 + (s - 100) / 100; // przebicie: kwota rośnie ponad zakres
      return { kind: 'gain', amount: Math.round(amount) };
    }
    acc += e.p;
  }
  return { kind: 'nothing', amount: 0 };
}

// ---------------- LICZNIK PECHA ----------------
// Jakość wyniku to jego percentyl (0..1) wśród losowań bez bonusu dla danej skrzyni ('daily' albo id skrzyni).
// Tablica referencyjna liczona jest raz (próbka), więc zmiana katalogu nie wymaga ręcznej kalibracji.
const SAMPLE_N = 20000;
const qualityTables = new Map();

function sampleValue(source) {
  if (source === 'daily') {
    const r = rollDailyChest(0);
    return r.amount + (r.item ? r.item.value : 0);
  }
  const item = rollShopChest(CHESTS[source], 0).item;
  return item ? item.value : 0;
}

function qualityTable(source) {
  let table = qualityTables.get(source);
  if (!table) {
    table = new Float64Array(SAMPLE_N);
    withRng(Math.random, () => { for (let i = 0; i < SAMPLE_N; i += 1) table[i] = sampleValue(source); });
    table.sort();
    qualityTables.set(source, table);
  }
  return table;
}

function bound(a, v, inclusive) {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (inclusive ? a[mid] <= v : a[mid] < v) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Percentyl wyniku: 0 = najgorszy możliwy, 1 = najlepszy
function quality(source, value) {
  const a = qualityTable(source);
  return (bound(a, value, false) + bound(a, value, true)) / 2 / a.length;
}

// O ile zmienia się licznik pecha po losowaniu o danej wartości (dodatni = pech, ujemny = dobry wynik).
// Licznik w bazie jest przycinany do 0..1, więc bonus nigdy nie jest ujemny.
function pityDelta(source, value) {
  return PITY_STEP * (PITY_THRESHOLD - quality(source, value));
}

// Data kalendarzowa w Polsce (YYYY-MM-DD), do limitu "raz dziennie"
const WARSAW_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' });
function warsawDate(ms = Date.now()) { return WARSAW_DATE.format(new Date(ms)); }

module.exports = {
  PERKS,
  TIER_NAMES, TIER_ICONS, ITEMS, CHESTS,
  MAX_LEVEL, LEVEL_BONUS, COMBO_BONUS, ONCE_BONUS, PITY_MAX, CHEST_SCALE, STRENGTH,
  LUCK_CAP, LUCK_COMBO_BONUS, DAILY_ITEM_CHANCE, DAILY_ITEM_CHANCE_BUDZIK,
  chance, isChest, getDef, luckBreakdown, totalBonus, pityBonus, luckyPick, dropItem, dropDailyItem,
  rollDailyChest, rollShopChest, rollChestContents, tierOdds, effectiveTierOdds, expectedItemValue,
  rollMoneyOnce, rollMoney, moneyScore, pityDelta, quality, withRng, warsawDate,
};
