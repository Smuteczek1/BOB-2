// ============================================================
//  KATALOG NAPADÓW, ETAPY (mini-gry), łup i kary. Same dane i czysta matematyka: żadnej bazy, żadnego Discorda.
//  Małe napady: solo albo z ekipą z bandy (do 3 osób, +10% łupu za każdą dodatkową osobę).
//  Duże skoki: tylko ekipa z JEDNEJ bandy (min. 3-6 osób), każdy gra swój etap, wszyscy dostają duży łup.
//  Łup to monety z gry (od Boba), nie z kieszeni graczy.
// ============================================================

const DAILY_LIMIT = Number(process.env.HEIST_DAILY_LIMIT ?? 3); // napadów na osobę dziennie (czas polski)
const MAX_GANG_MEMBERS = 8;
const MAX_GANGS_PER_USER = 2;
const CREW_BONUS = 0.1; // każda osoba ponad pierwszą dodaje tyle do łupu każdego uczestnika (małe napady)
const LOBBY_MS = 4 * 60_000; // tyle trwa zbieranie ekipy
const ACTION_MS = 6 * 60_000; // tyle ekipa ma na wykonanie swoich etapów

// Etapy: każdy to mini-gra (pamięć / rachunki / dopasowanie). Rola = nazwa zadania w ekipie.
const STAGE_TYPES = {
  zamek: { id: 'zamek', role: 'Włamywacz', name: 'Otwieranie zamków', emoji: '🔐', game: 'memory', pool: ['🔑', '🔒', '🗝️', '🔓', '🪛', '🔧'] },
  kierowca: { id: 'kierowca', role: 'Kierowca', name: 'Ucieczka samochodem', emoji: '🚗', game: 'memory', pool: ['⬆️', '⬇️', '⬅️', '➡️', '↗️', '↙️'] },
  hack: { id: 'hack', role: 'Haker', name: 'Włamanie do systemu', emoji: '💻', game: 'pick', bank: 'programista' },
  plan: { id: 'plan', role: 'Planista', name: 'Plan i rozpoznanie', emoji: '🗺️', game: 'pick', bank: 'napad' },
  sejf: { id: 'sejf', role: 'Łamacz sejfów', name: 'Liczenie i sejf', emoji: '🧮', game: 'math', math: 'boxes' },
};

// items: wymagane przedmioty (zużywane na starcie, zabiera się je liderowi / graczowi, który startuje)
// stages: [typ, liczba rund]; minLevel: poziom serwerowy; fine: grzywna za porażkę (część salda z dolnym i górnym limitem)
// jail: minuty aresztu za porażkę (0 = tylko mandat); w areszcie nie działa /praca ani napady
const HEISTS = {
  kiosk: { id: 'kiosk', name: 'Kiosk', emoji: '🏪', size: 'small', minLevel: 3, min: 1, max: 3, items: { wytrych: 1 }, stages: [['zamek', 2]], loot: [120, 260], fine: { pct: 0.03, min: 20, max: 150 }, jail: 0, desc: 'Cicho, szybko i bez świadków.' },
  auto: { id: 'auto', name: 'Kradzież auta', emoji: '🚘', size: 'small', minLevel: 10, min: 1, max: 3, items: { lom: 1 }, stages: [['zamek', 2], ['kierowca', 2]], loot: [350, 700], fine: { pct: 0.03, min: 30, max: 300 }, jail: 0, desc: 'Wsiąść, odpalić, zniknąć.' },
  jubiler: { id: 'jubiler', name: 'Jubiler', emoji: '💍', size: 'small', minLevel: 18, min: 1, max: 3, items: { wytrych: 1, przebranie: 1 }, stages: [['plan', 2], ['zamek', 3]], loot: [900, 1800], fine: { pct: 0.04, min: 50, max: 600 }, jail: 20, desc: 'Błyskotki pod szkłem i alarm w tle.' },
  magazyn: { id: 'magazyn', name: 'Magazyn towarów', emoji: '🏭', size: 'small', minLevel: 26, min: 1, max: 3, items: { lom: 1, krotkofalowka: 1 }, stages: [['plan', 2], ['kierowca', 3]], loot: [1800, 3500], fine: { pct: 0.04, min: 100, max: 1000 }, jail: 30, desc: 'Ochrona robi obchód co kwadrans.' },
  galeria: { id: 'galeria', name: 'Galeria sztuki', emoji: '🖼️', size: 'small', minLevel: 34, min: 1, max: 3, items: { wytrych: 1, mapa: 1, przebranie: 1 }, stages: [['plan', 3], ['zamek', 3], ['sejf', 2]], loot: [3500, 6500], fine: { pct: 0.05, min: 200, max: 2000 }, jail: 45, desc: 'Lasery, kamery i bezcenne obrazy.' },

  bank: { id: 'bank', name: 'Skok na bank', emoji: '🏦', size: 'big', minLevel: 20, min: 3, max: 5, items: { wytrych: 2, lom: 1, krotkofalowka: 1 }, stages: [['zamek', 3], ['hack', 3], ['kierowca', 3]], loot: [4000, 7000], fine: { pct: 0.05, min: 200, max: 2000 }, jail: 60, desc: 'Klasyk: skarbiec, system i ucieczka.' },
  kasyno: { id: 'kasyno', name: 'Skok na kasyno', emoji: '🎰', size: 'big', minLevel: 30, min: 4, max: 6, items: { wytrych: 2, przebranie: 2, mapa: 1, krotkofalowka: 1 }, stages: [['plan', 3], ['hack', 3], ['sejf', 3], ['kierowca', 3]], loot: [8000, 14000], fine: { pct: 0.06, min: 400, max: 4000 }, jail: 75, desc: 'Wejście w przebraniu, wyjście z workami.' },
  skarbiec: { id: 'skarbiec', name: 'Skarbiec państwowy', emoji: '🏛️', size: 'big', minLevel: 40, min: 5, max: 7, items: { wytrych: 3, lom: 2, krotkofalowka: 2, mapa: 1, przebranie: 2 }, stages: [['plan', 3], ['zamek', 3], ['hack', 3], ['sejf', 3], ['kierowca', 3]], loot: [16000, 28000], fine: { pct: 0.07, min: 800, max: 8000 }, jail: 90, desc: 'Największy skok w historii miasta.' },
  pociag: { id: 'pociag', name: 'Złoty pociąg', emoji: '🚂', size: 'big', minLevel: 46, min: 6, max: 8, items: { wytrych: 3, lom: 3, krotkofalowka: 3, mapa: 2, przebranie: 3 }, stages: [['plan', 3], ['zamek', 3], ['hack', 3], ['sejf', 3], ['kierowca', 3], ['zamek', 3]], loot: [30000, 50000], fine: { pct: 0.08, min: 1500, max: 12000 }, jail: 120, desc: 'Pociąg ze sztabkami w drodze do granicy.' },
};
const HEIST_LIST = Object.values(HEISTS).sort((a, b) => a.minLevel - b.minLevel);

// Etap zdał się, jeśli poprawna jest co najmniej połowa rund (zaokrąglona w górę)
const stagePassed = (hits, rounds) => hits >= Math.ceil(rounds / 2);

// Rozdział etapów między graczy (po kolei); solo gra wszystkie. Zwraca tablicę: dla każdego gracza lista indeksów etapów.
function assignStages(heist, playerCount) {
  const out = Array.from({ length: playerCount }, () => []);
  heist.stages.forEach((_, i) => out[i % playerCount].push(i));
  return out;
}

// Łup gracza: od dolnej do górnej granicy zależnie od skuteczności (poprawne rundy / wszystkie), z bonusem za większą ekipę (małe napady)
function lootFor(heist, performance, crewSize = 1) {
  const [min, max] = heist.loot;
  const p = Math.max(0, Math.min(1, performance));
  const bonus = heist.size === 'small' ? 1 + CREW_BONUS * Math.max(0, crewSize - 1) : 1;
  return Math.round((min + (max - min) * p) * bonus);
}

// Grzywna: część salda w granicach [min, max], nigdy więcej niż gracz ma
function fineFor(heist, balance) {
  const f = heist.fine;
  const raw = Math.max(f.min, Math.min(f.max, Math.floor(balance * f.pct)));
  return Math.max(0, Math.min(balance, raw));
}

const itemsText = (items, names) => Object.entries(items).map(([id, n]) => `${names[id] ?? id} ×${n}`).join(', ');

module.exports = {
  DAILY_LIMIT, MAX_GANG_MEMBERS, MAX_GANGS_PER_USER, CREW_BONUS, LOBBY_MS, ACTION_MS,
  STAGE_TYPES, HEISTS, HEIST_LIST, stagePassed, assignStages, lootFor, fineFor, itemsText,
};
