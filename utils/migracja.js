const fs = require('node:fs');
const path = require('node:path');

// Identyfikator migracji zapisywany w bazie: chroni przed przypadkowym drugim uruchomieniem
const MIGRATION_ID = 'reset-poziomow-2026-10';
const MIGRATION_FILE = path.join(__dirname, '..', 'data', 'migracja.csv');

// Prosty parser CSV: obsługuje cudzysłowy, przecinki w polach i BOM
function parseCsv(text) {
  const clean = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"' && clean[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.some((c) => c !== '')) rows.push(row);
  }
  return rows;
}

// Wczytuje data/migracja.csv. Plik możesz otworzyć i poprawić ręcznie (np. w Excelu) przed uruchomieniem.
function loadMigration(file = MIGRATION_FILE) {
  const [header, ...body] = parseCsv(fs.readFileSync(file, 'utf-8'));
  const col = Object.fromEntries(header.map((name, i) => [name.trim(), i]));
  for (const needed of ['user_id', 'nick', 'stary_poziom', 'stary_xp', 'nowy_poziom', 'nowe_xp', 'odznaka']) {
    if (!(needed in col)) throw new Error(`W pliku migracji brakuje kolumny "${needed}"`);
  }

  return body.map((r, idx) => {
    const row = {
      userId: r[col.user_id].trim(),
      nick: r[col.nick],
      oldLevel: Number(r[col.stary_poziom]),
      oldXp: Number(r[col.stary_xp]),
      newLevel: Number(r[col.nowy_poziom]),
      newXp: Number(r[col.nowe_xp]),
      badge: r[col.odznaka].trim().toLowerCase() === 'tak',
    };
    if (!/^\d{15,25}$/.test(row.userId)) throw new Error(`Wiersz ${idx + 2}: niepoprawne ID "${row.userId}"`);
    for (const k of ['oldLevel', 'oldXp', 'newLevel', 'newXp']) {
      if (!Number.isSafeInteger(row[k]) || row[k] < 0) throw new Error(`Wiersz ${idx + 2}: niepoprawna wartość w polu ${k}`);
    }
    return row;
  });
}

module.exports = { MIGRATION_ID, MIGRATION_FILE, parseCsv, loadMigration };
