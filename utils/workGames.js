// ============================================================
//  MINI-GRY DO ZADAŃ W PRACY (3 rundy, wszystko na przyciskach).
//  Trzy silniki: 'memory' (pamięć), 'math' (rachunki), 'pick' (dopasuj odpowiedź).
//  Czyste funkcje: losowość podajemy z zewnątrz (rng), dzięki czemu da się to dokładnie testować.
// ============================================================

const { JOBS, ROUNDS } = require('./jobs');

const MEMORY_LENGTHS = [3, 4, 5]; // długość sekwencji w kolejnych rundach

const ri = (rng, min, max) => min + Math.floor(rng() * (max - min + 1));
const pickOne = (rng, list) => list[Math.floor(rng() * list.length)];
function shuffle(list, rng) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const plural = (n, forms) => {
  const abs = Math.abs(n);
  if (abs === 1) return forms[0];
  const last = abs % 10;
  const lastTwo = abs % 100;
  return last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14) ? forms[1] : forms[2];
};

// ---------------- PAMIĘĆ ----------------
// Runda: sekwencja (różne emotki) do zapamiętania; gracz klika je w tej samej kolejności.
function memoryRound(job, round, rng) {
  const seq = shuffle(job.pool, rng).slice(0, MEMORY_LENGTHS[round] ?? MEMORY_LENGTHS[MEMORY_LENGTHS.length - 1]);
  return { seq, pool: [...job.pool] };
}

// pressed = dotychczas wciśnięte emotki. 'wrong' (pomyłka), 'done' (cała sekwencja poprawnie), 'ok' (jeszcze trwa)
function checkMemory(seq, pressed) {
  for (let i = 0; i < pressed.length; i++) if (pressed[i] !== seq[i]) return 'wrong';
  return pressed.length === seq.length ? 'done' : 'ok';
}

// ---------------- RACHUNKI ----------------
// Złe odpowiedzi: wartości bliskie poprawnej, bez duplikatów i liczb <= 0
function numberOptions(answer, rng, unit) {
  const cands = [answer + 1, answer - 1, answer + 2, answer - 2, answer + 5, answer - 5, answer + 10, answer - 10, answer * 2];
  const bad = shuffle([...new Set(cands.filter((n) => n > 0 && n !== answer))], rng).slice(0, 3);
  const all = shuffle([answer, ...bad], rng);
  const fmt = (n) => `${n.toLocaleString('pl-PL')}${unit ? ` ${unit}` : ''}`;
  return { options: all.map(fmt), correct: all.indexOf(answer) };
}

const banknote = (sum) => [20, 50, 100, 200, 500].find((b) => b >= sum) ?? sum;

const MATH = {
  change(round, rng) {
    if (round === 0) {
      const p = ri(rng, 11, 39);
      const paid = banknote(p + 1);
      return { question: `Klient płaci **${paid} zł** za zakupy za **${p} zł**. Ile reszty wydasz?`, answer: paid - p, unit: 'zł' };
    }
    if (round === 1) {
      const a = ri(rng, 12, 35); const b = ri(rng, 12, 35);
      const paid = banknote(a + b + 1);
      return { question: `Zakupy: **${a} zł** i **${b} zł**. Klient płaci **${paid} zł**. Ile reszty?`, answer: paid - a - b, unit: 'zł' };
    }
    const a = ri(rng, 15, 45); const b = ri(rng, 15, 45); const c = ri(rng, 15, 45);
    const paid = banknote(a + b + c + 1);
    return { question: `Zakupy: **${a} zł**, **${b} zł** i **${c} zł**. Klient płaci **${paid} zł**. Ile reszty?`, answer: paid - a - b - c, unit: 'zł' };
  },
  boxes(round, rng) {
    if (round === 0) {
      const n = ri(rng, 3, 6); const m = ri(rng, 5, 12);
      return { question: `W magazynie stoi **${n}** ${plural(n, ['paleta', 'palety', 'palet'])} po **${m}** skrzynek. Ile skrzynek razem?`, answer: n * m, unit: 'skrzynek' };
    }
    if (round === 1) {
      const n = ri(rng, 6, 9); const m = ri(rng, 12, 24);
      return { question: `Przyjechało **${n}** palet po **${m}** skrzynek. Ile skrzynek razem?`, answer: n * m, unit: 'skrzynek' };
    }
    const n = ri(rng, 4, 8); const m = ri(rng, 10, 20); const d = ri(rng, 2, 9);
    return { question: `**${n}** palet po **${m}** skrzynek, z czego **${d}** jest uszkodzonych. Ile dobrych skrzynek?`, answer: n * m - d, unit: 'skrzynek' };
  },
  coffee(round, rng) {
    if (round === 0) {
      const g = pickOne(rng, [16, 18, 20]); const n = ri(rng, 3, 8);
      return { question: `Jedna kawa to **${g} g** ziaren. Ile gramów na **${n}** kaw?`, answer: g * n, unit: 'g' };
    }
    if (round === 1) {
      const g = pickOne(rng, [16, 18, 20]); const n = ri(rng, 9, 15);
      return { question: `Jedna kawa to **${g} g** ziaren. Ile gramów na **${n}** kaw?`, answer: g * n, unit: 'g' };
    }
    const [P, g] = pickOne(rng, [[250, 25], [500, 20], [1000, 25], [500, 25], [1000, 20]]);
    return { question: `Paczka ma **${P} g** ziaren, a jedna kawa to **${g} g**. Ile kaw wyjdzie z jednej paczki?`, answer: P / g, unit: 'kaw' };
  },
  recipe(round, rng) {
    if (round === 0) {
      const X = pickOne(rng, [200, 400, 600]); const Y = pickOne(rng, [2, 6, 8]);
      return { question: `Przepis na **4** porcje: **${X} g** mąki. Ile mąki na **${Y}** porcji?`, answer: (X / 4) * Y, unit: 'g' };
    }
    if (round === 1) {
      const X = pickOne(rng, [300, 500, 700]); const Y = pickOne(rng, [6, 10, 12]);
      return { question: `Przepis na **4** porcje: **${X} ml** mleka. Ile mleka na **${Y}** porcji?`, answer: (X / 4) * Y, unit: 'ml' };
    }
    const X = pickOne(rng, [300, 420, 540]); const Y = pickOne(rng, [10, 15, 20]);
    return { question: `Na **6** gości potrzeba **${X} g** ryżu. Ile ryżu na **${Y}** gości?`, answer: (X / 6) * Y, unit: 'g' };
  },
  area(round, rng) {
    if (round === 0) {
      const a = ri(rng, 3, 6); const b = ri(rng, 4, 8);
      return { question: `Pokój ma **${a} m** na **${b} m**. Ile m² ma podłoga?`, answer: a * b, unit: 'm²' };
    }
    if (round === 1) {
      const a = ri(rng, 3, 6); const b = ri(rng, 4, 8); const c = ri(rng, 2, 5); const d = ri(rng, 3, 6);
      return { question: `Dwa pokoje: **${a}×${b} m** i **${c}×${d} m**. Ile m² razem?`, answer: a * b + c * d, unit: 'm²' };
    }
    const w = ri(rng, 5, 10); const h = ri(rng, 3, 4);
    return { question: `Ściana ma **${w} m** szerokości i **${h} m** wysokości. Puszka farby starcza na **8 m²**. Ile puszek kupisz (zaokrąglij w górę)?`, answer: Math.ceil((w * h) / 8), unit: 'puszek' };
  },
};

function mathRound(job, round, rng) {
  const q = MATH[job.math](round, rng);
  const { options, correct } = numberOptions(q.answer, rng, q.unit);
  return { question: q.question, options, correct };
}

// ---------------- DOPASUJ ODPOWIEDŹ ----------------
// q: pytanie, ok: poprawna odpowiedź, bad: trzy złe. Każda praca ma kilka pytań, w zadaniu losujemy 3.
const PICK_BANK = {
  ulotki: [
    { q: 'Gdzie najlepiej rozdawać ulotki o koncercie?', ok: 'Pod klubem muzycznym', bad: ['Na cmentarzu', 'W pustym lesie', 'Na środku autostrady'] },
    { q: 'Co powinno być na dobrej ulotce?', ok: 'Data, miejsce i hasło', bad: ['Same emotikony', 'Pusta kartka', 'Pięć stron małego tekstu'] },
    { q: 'Ktoś nie chce wziąć ulotki. Co robisz?', ok: 'Uśmiecham się i idę dalej', bad: ['Gonię go', 'Wpycham mu ją siłą', 'Zaczynam krzyczeć'] },
    { q: 'Zaczyna padać deszcz. Co robisz z ulotkami?', ok: 'Chowam je do teczki', bad: ['Zostawiam na deszczu', 'Wyrzucam wszystkie', 'Rozdaję mokre'] },
  ],
  kelner: [
    { q: 'Gość zamawia zupę. Co przynosisz razem z nią?', ok: 'Łyżkę', bad: ['Widelec', 'Nóż do steków', 'Pałeczki'] },
    { q: 'Zamówienie mogło się pomylić. Co robisz?', ok: 'Przepraszam i sprawdzam zamówienie', bad: ['Mówię, że to wina gościa', 'Ignoruję sprawę', 'Zabieram talerz bez słowa'] },
    { q: 'Gość prosi o rachunek. Co robisz?', ok: 'Przynoszę rachunek', bad: ['Przynoszę deser', 'Znikam na godzinę', 'Zamawiam mu kolejną zupę'] },
    { q: 'Kiedy zbierasz talerze ze stołu?', ok: 'Gdy goście skończyli jeść', bad: ['Gdy dopiero zaczęli', 'W trakcie rozmowy o ważnych sprawach', 'Zanim podam danie'] },
  ],
  mechanik: [
    { q: 'Auto nie odpala, a światła słabną. Podejrzewasz:', ok: 'Rozładowany akumulator', bad: ['Zepsute radio', 'Brudne szyby', 'Pękniętą szybę'] },
    { q: 'Hamulce piszczą. Na co patrzysz w pierwszej kolejności?', ok: 'Na klocki hamulcowe', bad: ['Na wycieraczki', 'Na klimatyzację', 'Na fotele'] },
    { q: 'Wymieniasz koło. Co robisz przed podniesieniem auta?', ok: 'Poluzowuję śruby koła', bad: ['Odkręcam silnik', 'Zdejmuję wszystkie śruby i czekam', 'Dokręcam hamulec ręczny do oporu w górę'] },
    { q: 'Którym narzędziem dokręcisz śrubę z zadanym momentem?', ok: 'Kluczem dynamometrycznym', bad: ['Młotkiem', 'Piłą', 'Obcęgami'] },
    { q: 'Poziom oleju silnikowego sprawdzasz:', ok: 'Bagnetem', bad: ['Termosem', 'Linijką z dachu', 'Łyżką'] },
  ],
  elektryk: [
    { q: 'Zanim zaczniesz pracę przy instalacji, co robisz?', ok: 'Wyłączam prąd i sprawdzam brak napięcia', bad: ['Zakładam mokre rękawice', 'Dotykam przewodów, żeby sprawdzić', 'Wyłączam tylko światło'] },
    { q: 'Jaki kolor ma zwykle przewód uziemiający?', ok: 'Żółto-zielony', bad: ['Czerwony', 'Różowy', 'Fioletowy'] },
    { q: 'Co chroni instalację przed przeciążeniem?', ok: 'Bezpiecznik', bad: ['Żarówka', 'Gniazdko', 'Kabel przedłużacz'] },
    { q: 'Jednostką natężenia prądu jest:', ok: 'Amper', bad: ['Wolt', 'Wat', 'Metr'] },
    { q: 'Do czego służy miernik uniwersalny?', ok: 'Do pomiaru napięcia i oporu', bad: ['Do wbijania gwoździ', 'Do cięcia kabli', 'Do malowania ścian'] },
  ],
  programista: [
    { q: 'Aplikacja się zawiesza. Co sprawdzasz najpierw?', ok: 'Logi błędów', bad: ['Kolor tła', 'Czcionkę w menu', 'Tapetę na pulpicie'] },
    { q: 'Co robisz przed zmianą w działającym systemie?', ok: 'Testuję i robię kopię zapasową', bad: ['Zmieniam bez testów', 'Kasuję bazę danych', 'Wyłączam monitoring'] },
    { q: 'Do czego służy system kontroli wersji (np. Git)?', ok: 'Do śledzenia zmian w kodzie', bad: ['Do edycji zdjęć', 'Do pisania maili', 'Do grania w gry'] },
    { q: 'Pętla nieskończona powoduje, że:', ok: 'Program się nie kończy', bad: ['Prąd się oszczędza', 'Monitor pęka', 'Internet przyspiesza'] },
    { q: 'Czym jest „bug”?', ok: 'Błędem w programie', bad: ['Nową funkcją', 'Rodzajem klawiatury', 'Wersją językową'] },
  ],
};

function pickRound(job, round, rng, used) {
  const bank = PICK_BANK[job.id];
  const free = bank.map((_, i) => i).filter((i) => !used.has(i));
  const idx = pickOne(rng, free.length ? free : bank.map((_, i) => i));
  used.add(idx);
  const item = bank[idx];
  const options = shuffle([item.ok, ...item.bad], rng);
  return { question: item.q, options, correct: options.indexOf(item.ok) };
}

// ---------------- GRA ----------------
// Zwraca { kind, jobId, rounds: [ ... ROUNDS rund ... ] }
function makeGame(jobId, rng = Math.random) {
  const job = JOBS[jobId];
  if (!job) throw new Error(`Nieznana praca: ${jobId}`);
  const rounds = [];
  const used = new Set();
  for (let r = 0; r < ROUNDS; r++) {
    if (job.game === 'memory') rounds.push(memoryRound(job, r, rng));
    else if (job.game === 'math') rounds.push(mathRound(job, r, rng));
    else rounds.push(pickRound(job, r, rng, used));
  }
  return { kind: job.game, jobId, rounds };
}

module.exports = { makeGame, checkMemory, PICK_BANK, MEMORY_LENGTHS };
