// ============================================================
//  KATALOG PRAC (poziomy serwerowe 0-50), stopnie kariery i oferty dnia.
//  Same dane i czysta matematyka: żadnej bazy, żadnego Discorda (łatwo to testować i zmieniać).
// ============================================================

const ENERGY_MAX = Number(process.env.WORK_ENERGY_MAX ?? 100); // bazowy maksymalny zapas energii
const ENERGY_REGEN = Number(process.env.WORK_ENERGY_REGEN ?? 5); // bazowa regeneracja: energii na godzinę (ciągła, bez resetu o północy)
const CHAIR_PER_LEVEL = 10; // Ergonomiczne krzesło: +max energii za każdy poziom (max 5 poziomów)
const ESPRESSO_PER_LEVEL = 1; // Ekspres do kawy: +energii/h za każdy poziom (max 5 poziomów)
const TASK_COOLDOWN_MIN = Number(process.env.WORK_TASK_COOLDOWN_MIN ?? 10); // przerwa między zadaniami (mini-grami)
const XP_PER_LEVEL = 5; // Notes mistrza: +% XP z pracy za poziom
const PAY_PER_LEVEL = 4; // Złota teczka: +% monet z pracy za poziom
const CLOCK_PER_LEVEL = 1; // Zegarek szefa: o tyle minut krótsza przerwa między zadaniami za poziom
const PROMO_PER_LEVEL = 4; // Dyplom awansu: o tyle % mniej zmian potrzeba na awans za poziom
const BATTERY_PER_LEVEL = 10; // Powerbank: +% energii z Kawy, Energetyka itp. za poziom
const ORDERS_PER_HOUR = 3; // tyle zleceń co godzinę
const BENEFIT = Number(process.env.WORK_BENEFIT ?? 60); // zasiłek dla bezrobotnych (raz dziennie)
const OFFERS_PER_DAY = 4; // ile ofert pracy widzi gracz danego dnia (oprócz swojej obecnej pracy)
const ROUNDS = 3; // rund w zadaniu (mini-grze)

// Stopnie kariery w każdej pracy: ile zmian w TEJ pracy trzeba mieć i jaki mnożnik wypłaty to daje
const RANK_SHIFTS = [0, 8, 25, 55, 100];
const RANK_MULT = [1, 1.15, 1.35, 1.6, 1.9];

// Zadanie (mini-gra): mnożnik wypłaty zależnie od liczby poprawnych rund (0-3). Bez grzywien: najgorzej 70%.
const TASK_MULT = [0.7, 0.9, 1.1, 1.3];
const TASK_XP_BONUS = 1.2;

// Zlecenia: co godzinę każdy gracz dostaje 3 losowe zlecenia z różnych tematów (niezależnie od zawodu).
// Każde to jedna z mini-gier (pamięć / rachunki / dopasowanie) o losowej długości 1-3 rund. Nagroda zależy od POZIOMU serwerowego,
// nie od pracy, więc zlecenia mogą robić też bezrobotni. Nowa lista pojawia się o pełnej godzinie.
const ORDER_SIZES = {
  1: { rounds: 1, energy: 8, pay: 0.4, xp: 0.4 },
  2: { rounds: 2, energy: 14, pay: 0.8, xp: 0.75 },
  3: { rounds: 3, energy: 20, pay: 1.3, xp: 1.3 },
};
const ORDER_SIZE_WEIGHTS = [30, 40, 30]; // szansa na 1, 2 i 3 rundy (%)
const ORDER_BASE_PAY = 30; // wypłata bazowa zlecenia przy poziomie 0
const ORDER_PAY_PER_LEVEL = 8; // + za każdy poziom serwerowy (poziom 50 = 430, jak najlepsza praca)
const ORDER_BASE_XP = 14;
const ORDER_XP_PER_LEVEL = 1.2;
// game: 'memory' | 'math' | 'pick'; math: rodzaj rachunków; pool: emotki do zapamiętania; bank: zestaw pytań (klucz z PICK_BANK)
const ORDER_THEMES = [
  { id: 'budowlane', name: 'Budowlane', emoji: '🏗️', game: 'memory', pool: ['🔨', '🪚', '🧱', '🪜', '🔧', '⛏️'], titles: ['Remont łazienki', 'Garaż na działce', 'Mur wokół ogrodu', 'Dach na altance'] },
  { id: 'ogrodnicze', name: 'Ogrodnicze', emoji: '🌱', game: 'memory', pool: ['🌱', '🌷', '🌳', '🪴', '🌻', '🥕'], titles: ['Nowy trawnik', 'Rabata przed domem', 'Warzywnik za płotem', 'Przycinanie żywopłotu'] },
  { id: 'porzadki', name: 'Porządkowe', emoji: '🧹', game: 'memory', pool: ['🧽', '🧴', '🪣', '🧹', '🧻', '🗑️'], titles: ['Sprzątanie biura', 'Porządki po imprezie', 'Mycie okien', 'Generalne porządki'] },
  { id: 'magazynowe', name: 'Magazynowe', emoji: '📦', game: 'math', math: 'boxes', titles: ['Rozładunek ciężarówki', 'Inwentaryzacja półek', 'Palety do wysyłki', 'Pakowanie zamówień'] },
  { id: 'gastro', name: 'Gastronomiczne', emoji: '🍳', game: 'math', math: 'recipe', titles: ['Catering na wesele', 'Obiady dla firmy', 'Przepis na większą ekipę', 'Kuchnia na festiwalu'] },
  { id: 'sklepowe', name: 'Sklepowe', emoji: '🛒', game: 'math', math: 'change', titles: ['Zmiana przy kasie', 'Wyprzedaż w sklepie', 'Kasa na targu', 'Sobota w supermarkecie'] },
  { id: 'kawiarniane', name: 'Kawiarniane', emoji: '☕', game: 'math', math: 'coffee', titles: ['Poranny szczyt w kawiarni', 'Kawa na konferencję', 'Nowa karta kaw', 'Barista na evencie'] },
  { id: 'projektowe', name: 'Projektowe', emoji: '📐', game: 'math', math: 'area', titles: ['Projekt mieszkania', 'Kosztorys podłogi', 'Plan działki', 'Przeliczenie powierzchni'] },
  { id: 'serwisowe', name: 'Serwisowe', emoji: '🔧', game: 'pick', bank: 'mechanik', titles: ['Awaria w warsztacie', 'Przegląd auta', 'Naprawa roweru', 'Diagnoza usterki'] },
  { id: 'elektryczne', name: 'Elektryczne', emoji: '⚡', game: 'pick', bank: 'elektryk', titles: ['Nowa instalacja', 'Wymiana gniazdek', 'Awaria bezpiecznika', 'Oświetlenie sklepu'] },
  { id: 'it', name: 'Informatyczne', emoji: '💻', game: 'pick', bank: 'programista', titles: ['Błąd na produkcji', 'Nowa strona firmowa', 'Poprawka w aplikacji', 'Wsparcie techniczne'] },
];
const ORDER_THEME_BY_ID = Object.fromEntries(ORDER_THEMES.map((t) => [t.id, t]));
// zadanie daje o 20% więcej XP niż zmiana czasowa

// game: silnik mini-gry ('memory' pamięć, 'math' rachunki, 'pick' dopasuj odpowiedź)
// math: rodzaj zadań rachunkowych (tylko dla game 'math')
// base: wypłata za zmianę na pierwszym stopniu, xp: XP serwerowe za zmianę, minutes: czas zmiany czasowej
const JOBS = {
  sprzatacz: {
    id: 'sprzatacz', name: 'Sprzątacz', emoji: '🧹', minLevel: 0, energy: 20, base: 40, xp: 18, minutes: 30, game: 'memory',
    pool: ['🧽', '🧴', '🪣', '🧹', '🧻', '🗑️'],
    ranks: ['Nowy sprzątacz', 'Sprzątacz', 'Starszy sprzątacz', 'Brygadzista', 'Kierownik sprzątania'],
    desc: 'Czysto, jasno i bez narzekania. Dobry początek.',
  },
  ulotki: {
    id: 'ulotki', name: 'Roznosiciel ulotek', emoji: '📄', minLevel: 0, energy: 20, base: 42, xp: 18, minutes: 30, game: 'pick',
    ranks: ['Nowy roznosiciel', 'Roznosiciel ulotek', 'Starszy roznosiciel', 'Koordynator akcji', 'Szef kampanii'],
    desc: 'Ulotki do rąk, uśmiech na twarz.',
  },
  zmywak: {
    id: 'zmywak', name: 'Zmywak', emoji: '🍽️', minLevel: 3, energy: 20, base: 50, xp: 20, minutes: 40, game: 'memory',
    pool: ['🍽️', '🥄', '🍴', '🫖', '🥣', '🧼'],
    ranks: ['Nowy zmywak', 'Zmywak', 'Starszy zmywak', 'Szef zmywaka', 'Kierownik zmiany'],
    desc: 'Talerze same się nie umyją.',
  },
  magazynier: {
    id: 'magazynier', name: 'Magazynier', emoji: '📦', minLevel: 3, energy: 20, base: 52, xp: 20, minutes: 40, game: 'math', math: 'boxes',
    ranks: ['Nowy magazynier', 'Magazynier', 'Starszy magazynier', 'Brygadzista magazynu', 'Kierownik magazynu'],
    desc: 'Palety, skrzynki i dużo liczenia.',
  },
  kasjer: {
    id: 'kasjer', name: 'Kasjer', emoji: '🛒', minLevel: 7, energy: 20, base: 70, xp: 24, minutes: 45, game: 'math', math: 'change',
    ranks: ['Nowy kasjer', 'Kasjer', 'Starszy kasjer', 'Kasjer-instruktor', 'Kierownik sklepu'],
    desc: 'Szybka kasa i dokładna reszta.',
  },
  kurier: {
    id: 'kurier', name: 'Kurier', emoji: '🚴', minLevel: 12, energy: 25, base: 100, xp: 30, minutes: 60, game: 'memory',
    pool: ['🏠', '🏢', '🏪', '🏫', '🏥', '⛪'],
    ranks: ['Nowy kurier', 'Kurier', 'Starszy kurier', 'Kurier ekspresowy', 'Szef floty'],
    desc: 'Paczki muszą trafić pod właściwy adres.',
  },
  kelner: {
    id: 'kelner', name: 'Kelner', emoji: '🍕', minLevel: 12, energy: 25, base: 104, xp: 30, minutes: 60, game: 'pick',
    ranks: ['Nowy kelner', 'Kelner', 'Starszy kelner', 'Główny kelner', 'Manager sali'],
    desc: 'Dobra obsługa to dobre napiwki.',
  },
  barista: {
    id: 'barista', name: 'Barista', emoji: '☕', minLevel: 18, energy: 25, base: 130, xp: 36, minutes: 60, game: 'math', math: 'coffee',
    ranks: ['Nowy barista', 'Barista', 'Starszy barista', 'Główny barista', 'Mistrz kawy'],
    desc: 'Kawa idealna zaczyna się od dobrych proporcji.',
  },
  mechanik: {
    id: 'mechanik', name: 'Mechanik', emoji: '🔧', minLevel: 24, energy: 25, base: 165, xp: 42, minutes: 75, game: 'pick',
    ranks: ['Uczeń mechanika', 'Mechanik', 'Starszy mechanik', 'Mistrz warsztatu', 'Szef serwisu'],
    desc: 'Każdą usterkę da się znaleźć.',
  },
  ochroniarz: {
    id: 'ochroniarz', name: 'Ochroniarz', emoji: '🛡️', minLevel: 27, energy: 25, base: 175, xp: 44, minutes: 75, game: 'memory',
    pool: ['🚪', '🔑', '📹', '🔦', '🚨', '🔒'],
    ranks: ['Nowy ochroniarz', 'Ochroniarz', 'Starszy ochroniarz', 'Dowódca zmiany', 'Szef ochrony'],
    desc: 'Obchód, kamery i czujne oko.',
  },
  elektryk: {
    id: 'elektryk', name: 'Elektryk', emoji: '⚡', minLevel: 30, energy: 33, base: 260, xp: 50, minutes: 90, game: 'pick',
    ranks: ['Uczeń elektryka', 'Elektryk', 'Starszy elektryk', 'Mistrz elektryk', 'Główny inżynier instalacji'],
    desc: 'Bezpieczeństwo przede wszystkim. Najpierw wyłącz prąd.',
  },
  kucharz: {
    id: 'kucharz', name: 'Kucharz', emoji: '👨‍🍳', minLevel: 36, energy: 33, base: 290, xp: 56, minutes: 90, game: 'math', math: 'recipe',
    ranks: ['Pomocnik kucharza', 'Kucharz', 'Starszy kucharz', 'Zastępca szefa kuchni', 'Szef kuchni'],
    desc: 'Przepisy trzeba umieć przeliczać na każdą liczbę gości.',
  },
  programista: {
    id: 'programista', name: 'Programista', emoji: '💻', minLevel: 42, energy: 33, base: 360, xp: 64, minutes: 90, game: 'pick',
    ranks: ['Junior programista', 'Programista', 'Starszy programista', 'Tech lead', 'Główny architekt systemów'],
    desc: 'Kod, kawa i rzadko śpiące serwery.',
  },
  architekt: {
    id: 'architekt', name: 'Architekt', emoji: '📐', minLevel: 50, energy: 33, base: 430, xp: 72, minutes: 90, game: 'math', math: 'area',
    ranks: ['Młodszy architekt', 'Architekt', 'Starszy architekt', 'Główny projektant', 'Architekt naczelny'],
    desc: 'Szczyt kariery: projekty, które stoją.',
  },
};

const JOB_LIST = Object.values(JOBS).sort((a, b) => a.minLevel - b.minLevel || a.id.localeCompare(b.id));

// ---------------- KARIERA ----------------
// Indeks stopnia (0-4) dla liczby przepracowanych zmian w danej pracy
// promo = poziom Dyplomu awansu (zmniejsza liczbę zmian wymaganych na każdy awans)
const needShifts = (i, promo = 0) => Math.ceil(RANK_SHIFTS[i] * (1 - (PROMO_PER_LEVEL * Math.max(0, promo)) / 100));
function rankIndex(shifts, promo = 0) {
  let idx = 0;
  for (let i = 0; i < RANK_SHIFTS.length; i++) if (shifts >= needShifts(i, promo)) idx = i;
  return idx;
}

function rankInfo(jobId, shifts, promo = 0) {
  const job = JOBS[jobId];
  const idx = rankIndex(shifts, promo);
  const next = idx < RANK_SHIFTS.length - 1 ? { name: job.ranks[idx + 1], shifts: needShifts(idx + 1, promo) } : null;
  return { idx, name: job.ranks[idx], mult: RANK_MULT[idx], next };
}

// Wypłata za jedną zmianę na danym stopniu (mult: np. mnożnik zadania, domyślnie 1 = zmiana czasowa)
const payFor = (jobId, shifts, mult = 1, promo = 0) => Math.max(1, Math.round(JOBS[jobId].base * RANK_MULT[rankIndex(shifts, promo)] * mult));
const xpFor = (jobId, task = false) => Math.round(JOBS[jobId].xp * (task ? TASK_XP_BONUS : 1));
// Mnożnik wypłaty za wynik: 0..rounds poprawnych rund -> 0.7 .. 1.3 (dla 3 rund: 0.7 / 0.9 / 1.1 / 1.3)
const taskMult = (hits, rounds = ROUNDS) => {
  const r = Math.max(0, Math.min(1, rounds > 0 ? hits / rounds : 0));
  return Math.round((TASK_MULT[0] + (TASK_MULT[TASK_MULT.length - 1] - TASK_MULT[0]) * r) * 100) / 100;
};
const maxEnergy = (chairLevel = 0) => ENERGY_MAX + CHAIR_PER_LEVEL * Math.max(0, chairLevel);
const regenPerHour = (espressoLevel = 0) => ENERGY_REGEN + ESPRESSO_PER_LEVEL * Math.max(0, espressoLevel);
// Wypłata i XP zlecenia o danej liczbie rund (1-3) dla poziomu serwerowego gracza (bez pracy)
const orderReward = (rounds, level) => {
  const size = ORDER_SIZES[rounds];
  const lv = Math.max(0, Math.floor(level));
  return {
    pay: Math.max(1, Math.round((ORDER_BASE_PAY + ORDER_PAY_PER_LEVEL * lv) * size.pay)),
    xp: Math.max(1, Math.round((ORDER_BASE_XP + ORDER_XP_PER_LEVEL * lv) * size.xp)),
  };
};

// ---------------- LOSOWOŚĆ POWTARZALNA (oferty dnia) ----------------
function hashSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}
function seededRng(seed) {
  const next = hashSeed(seed);
  let a = next();
  return () => {
    // mulberry32
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled(list, rng) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Oferty dnia: 4 losowe prace (inne dla każdego gracza, stałe w ciągu dnia). Co najmniej 2 są dostępne od razu
// (jeśli tyle jest), reszta może być zablokowana poziomem, żeby było do czego dążyć. Obecna praca nie jest tu liczona.
// offersLevel = poziom gracza z początku dnia (żeby lista nie zmieniała się w ciągu dnia po awansie).
function offersFor(guildId, userId, dayKey, offersLevel, currentJobId = null) {
  const rng = seededRng(`${guildId}:${userId}:${dayKey}`);
  const pool = JOB_LIST.filter((j) => j.id !== currentJobId);
  const open = shuffled(pool.filter((j) => j.minLevel <= offersLevel), rng);
  const picked = open.slice(0, 2);
  const rest = shuffled(pool.filter((j) => !picked.includes(j)), rng);
  const result = [...picked, ...rest.slice(0, OFFERS_PER_DAY - picked.length)];
  return shuffled(result, rng).map((j) => j.id);
}

// Zlecenia na daną godzinę (slot = godzina od epoki): 3 różne tematy, losowa długość. Takie same przy każdym odczycie w tej godzinie.
// level = poziom serwerowy (do nagrody), doneIdx = numery już wykonanych zleceń.
function ordersForSlot(guildId, userId, slot, level, doneIdx = []) {
  const rng = seededRng(`${guildId}:${userId}:orders:${slot}`);
  const themes = shuffled(ORDER_THEMES, rng).slice(0, ORDERS_PER_HOUR);
  return themes.map((theme, idx) => {
    const roll = rng() * 100;
    const rounds = roll < ORDER_SIZE_WEIGHTS[0] ? 1 : roll < ORDER_SIZE_WEIGHTS[0] + ORDER_SIZE_WEIGHTS[1] ? 2 : 3;
    const title = theme.titles[Math.floor(rng() * theme.titles.length)];
    return { idx, slot, themeId: theme.id, theme, title, rounds, energy: ORDER_SIZES[rounds].energy, ...orderReward(rounds, level), done: doneIdx.includes(idx) };
  });
}

module.exports = {
  ORDER_SIZES,
  ORDER_THEMES,
  ORDER_THEME_BY_ID,
  ordersForSlot,
  ENERGY_MAX,
  ENERGY_REGEN,
  CHAIR_PER_LEVEL,
  ESPRESSO_PER_LEVEL,
  TASK_COOLDOWN_MIN,
  ORDERS_PER_HOUR,
  XP_PER_LEVEL,
  PAY_PER_LEVEL,
  CLOCK_PER_LEVEL,
  PROMO_PER_LEVEL,
  BATTERY_PER_LEVEL,
  needShifts,
  maxEnergy,
  regenPerHour,
  orderReward,
  BENEFIT,
  OFFERS_PER_DAY,
  ROUNDS,
  RANK_SHIFTS,
  RANK_MULT,
  TASK_MULT,
  JOBS,
  JOB_LIST,
  rankIndex,
  rankInfo,
  payFor,
  xpFor,
  taskMult,
  offersFor,
  seededRng,
};
