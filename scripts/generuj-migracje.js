// Generuje data/migracja.csv z eksportu poziomów (komenda /eksport-poziomow).
// Uruchomienie:  node scripts/generuj-migracje.js scripts/poziomy-eksport.csv
//
// ZASADY (zmieniasz tu, potem generujesz plik od nowa):
const MAX_NEW_LEVEL = 20;        // osoba z najwyższym dotychczasowym poziomem dostaje ten poziom
const BADGE_MIN_OLD_LEVEL = 30;  // od jakiego STAREGO poziomu (włącznie) przysługuje odznaka "Byłem tu"
//
// WZÓR: nowy_poziom = zaokrąglenie( MAX_NEW_LEVEL * stary_poziom / najwyższy_stary_poziom )
// czyli proporcjonalnie: im mniej ktoś miał, tym mniej dostaje.
// Nowe XP = dokładnie tyle, ile potrzeba do wejścia na ten nowy poziom (bez "resztek").

const fs = require('node:fs');
const path = require('node:path');
const { parseCsv } = require('../utils/migracja');

// Ten sam wzór co w bocie (utils/leveling.js), skopiowany, żeby skrypt działał bez discord.js
function xpNeededForLevel(level) {
  return Math.floor(100 * Math.pow(1.05, level - 1));
}
function xpAtLevelStart(level) {
  let total = 0;
  for (let l = 1; l <= level; l++) total += xpNeededForLevel(l);
  return total;
}

const input = process.argv[2];
if (!input) {
  console.error('Podaj plik wejściowy: node scripts/generuj-migracje.js scripts/poziomy-eksport.csv');
  process.exit(1);
}

const [header, ...body] = parseCsv(fs.readFileSync(input, 'utf-8'));
const col = Object.fromEntries(header.map((n, i) => [n.trim(), i]));
const people = body.map((r) => ({
  userId: r[col.user_id],
  nick: r[col.nick],
  oldXp: Number(r[col.xp]),
  oldLevel: Number(r[col.poziom_z_xp]),
}));

const maxOld = Math.max(...people.map((p) => p.oldLevel));
const q = (v) => `"${String(v).replace(/"/g, '""')}"`;

const lines = ['user_id,nick,stary_poziom,stary_xp,nowy_poziom,nowe_xp,odznaka'];
for (const p of people) {
  const newLevel = Math.round((MAX_NEW_LEVEL * p.oldLevel) / maxOld);
  const newXp = xpAtLevelStart(newLevel);
  const badge = p.oldLevel >= BADGE_MIN_OLD_LEVEL ? 'tak' : 'nie';
  lines.push([q(p.userId), q(p.nick), p.oldLevel, p.oldXp, newLevel, newXp, badge].join(','));
}

const out = path.join(__dirname, '..', 'data', 'migracja.csv');
fs.writeFileSync(out, '\uFEFF' + lines.join('\n') + '\n', 'utf-8');
console.log(`Zapisano ${people.length} wierszy do ${out} (najwyższy stary poziom: ${maxOld})`);
