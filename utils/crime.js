const db = require('../db');
const inv = require('./inventory');
const H = require('./heists');

// ============================================================
//  NAPADY: baza (areszt, dzienny limit), BANDY (grupy przestępcze) i przebieg napadu.
//  Tabele powstają leniwie (ensureSchema). Wypłaty łupu to monety z gry (applyCredit, powód crime_<id>);
//  grzywna idzie do księgi jako crime_fine. Atomowo: napad zużywa przedmioty i zlicza limity w jednej transakcji.
// ============================================================

let schemaReady = null;
function ensureSchema() {
  schemaReady ??= db.raw
    .query(`
      CREATE TABLE IF NOT EXISTS heist_profiles (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        jail_until BIGINT NOT NULL DEFAULT 0,
        day TEXT,
        heists_today INT NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS gangs (
        id BIGSERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        name TEXT NOT NULL,
        leader_id TEXT NOT NULL,
        created_at BIGINT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_gangs_name ON gangs (guild_id, lower(name));
      CREATE TABLE IF NOT EXISTS gang_members (
        gang_id BIGINT NOT NULL,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        joined_at BIGINT NOT NULL,
        PRIMARY KEY (gang_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_gang_members_user ON gang_members (guild_id, user_id);
      CREATE TABLE IF NOT EXISTS gang_invites (
        gang_id BIGINT NOT NULL,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        invited_by TEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        PRIMARY KEY (gang_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS heist_runs (
        id BIGSERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        heist_id TEXT NOT NULL,
        gang_id BIGINT,
        leader_id TEXT NOT NULL,
        players TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        started_at BIGINT NOT NULL,
        closed_at BIGINT
      );
    `)
    .catch((err) => { schemaReady = null; throw err; });
  return schemaReady;
}

const dayKey = (now) => new Date(now).toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
const lockUser = (c, guildId, userId) => c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`crime:${guildId}:${userId}`]);

// ---------------- PROFIL: areszt i dzienny limit ----------------
async function readProfile(c, guildId, userId, now) {
  await c.query('INSERT INTO heist_profiles (guild_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [guildId, userId]);
  const row = (await c.query('SELECT * FROM heist_profiles WHERE guild_id = $1 AND user_id = $2 FOR UPDATE', [guildId, userId])).rows[0];
  const today = dayKey(now);
  if (row.day !== today) {
    row.day = today;
    row.heists_today = 0;
    await c.query('UPDATE heist_profiles SET day = $3, heists_today = 0 WHERE guild_id = $1 AND user_id = $2', [guildId, userId, today]);
  }
  return row;
}

async function getProfile(guildId, userId, now = Date.now()) {
  await ensureSchema();
  return db.withTransaction(async (c) => {
    const row = await readProfile(c, guildId, userId, now);
    const jailUntil = Number(row.jail_until);
    return { jailUntil: jailUntil > now ? jailUntil : 0, heistsToday: row.heists_today, left: Math.max(0, H.DAILY_LIMIT - row.heists_today) };
  });
}

// Do sprawdzania w /praca: do kiedy trwa areszt (0 = wolny)
async function jailUntil(guildId, userId, now = Date.now(), c = db.raw) {
  await ensureSchema();
  const res = await c.query('SELECT jail_until FROM heist_profiles WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
  const until = Number(res.rows[0]?.jail_until ?? 0);
  return until > now ? until : 0;
}

// ---------------- BANDY ----------------
const cleanName = (name) => String(name ?? '').replace(/\s+/g, ' ').trim();
const validName = (name) => /^[\p{L}\p{N} _'\-.!]{3,20}$/u.test(name);

async function gangsOf(c, guildId, userId) {
  const res = await c.query(
    `SELECT g.* FROM gangs g JOIN gang_members m ON m.gang_id = g.id
     WHERE g.guild_id = $1 AND m.user_id = $2 ORDER BY g.id`,
    [guildId, userId],
  );
  return res.rows.map((r) => ({ id: Number(r.id), name: r.name, leaderId: r.leader_id }));
}

async function membersOf(c, gangId) {
  const res = await c.query('SELECT user_id, joined_at FROM gang_members WHERE gang_id = $1 ORDER BY joined_at, user_id', [gangId]);
  return res.rows.map((r) => ({ userId: r.user_id, joinedAt: Number(r.joined_at) }));
}

// Moje bandy (max 2) z członkami
async function getMyGangs(guildId, userId) {
  await ensureSchema();
  const gangs = await gangsOf(db.raw, guildId, userId);
  for (const g of gangs) g.members = await membersOf(db.raw, g.id);
  return gangs;
}

// reason: name (zła nazwa) | taken (zajęta) | limit (masz już 2 bandy)
async function createGang(guildId, leaderId, rawName, now = Date.now()) {
  await ensureSchema();
  const name = cleanName(rawName);
  if (!validName(name)) return { ok: false, reason: 'name' };
  return db.withTransaction(async (c) => {
    await lockUser(c, guildId, leaderId);
    if ((await gangsOf(c, guildId, leaderId)).length >= H.MAX_GANGS_PER_USER) return { ok: false, reason: 'limit' };
    try {
      await c.query('SAVEPOINT g');
      const res = await c.query('INSERT INTO gangs (guild_id, name, leader_id, created_at) VALUES ($1, $2, $3, $4::bigint) RETURNING id', [guildId, name, leaderId, now]);
      await c.query('INSERT INTO gang_members (gang_id, guild_id, user_id, joined_at) VALUES ($1, $2, $3, $4::bigint)', [res.rows[0].id, guildId, leaderId, now]);
      return { ok: true, id: Number(res.rows[0].id), name };
    } catch (err) {
      if (err.code === '23505') {
        await c.query('ROLLBACK TO SAVEPOINT g');
        return { ok: false, reason: 'taken' };
      }
      throw err;
    }
  });
}

// reason: not_leader | member (już w bandzie) | full | target_limit (ma już 2 bandy) | invited (już zaproszony)
async function invite(guildId, gangId, leaderId, targetId, now = Date.now()) {
  await ensureSchema();
  return db.withTransaction(async (c) => {
    const g = (await c.query('SELECT * FROM gangs WHERE id = $1 AND guild_id = $2 FOR UPDATE', [gangId, guildId])).rows[0];
    if (!g || g.leader_id !== leaderId) return { ok: false, reason: 'not_leader' };
    const members = await membersOf(c, gangId);
    if (members.some((m) => m.userId === targetId)) return { ok: false, reason: 'member' };
    if (members.length >= H.MAX_GANG_MEMBERS) return { ok: false, reason: 'full' };
    if ((await gangsOf(c, guildId, targetId)).length >= H.MAX_GANGS_PER_USER) return { ok: false, reason: 'target_limit' };
    const res = await c.query(
      `INSERT INTO gang_invites (gang_id, guild_id, user_id, invited_by, expires_at) VALUES ($1, $2, $3, $4, $5::bigint)
       ON CONFLICT (gang_id, user_id) DO UPDATE SET expires_at = EXCLUDED.expires_at, invited_by = EXCLUDED.invited_by
       WHERE gang_invites.expires_at < $6::bigint RETURNING gang_id`,
      [gangId, guildId, targetId, leaderId, now + 48 * 3_600_000, now],
    );
    if (res.rowCount === 0) return { ok: false, reason: 'invited' };
    return { ok: true, gangName: g.name };
  });
}

async function getInvites(guildId, userId, now = Date.now()) {
  await ensureSchema();
  const res = await db.raw.query(
    `SELECT i.gang_id, i.invited_by, i.expires_at, g.name FROM gang_invites i JOIN gangs g ON g.id = i.gang_id
     WHERE i.guild_id = $1 AND i.user_id = $2 AND i.expires_at > $3::bigint ORDER BY i.expires_at DESC`,
    [guildId, userId, now],
  );
  return res.rows.map((r) => ({ gangId: Number(r.gang_id), name: r.name, invitedBy: r.invited_by, expiresAt: Number(r.expires_at) }));
}

// reason: gone (brak zaproszenia) | limit (masz już 2 bandy) | full
async function acceptInvite(guildId, userId, gangId, now = Date.now()) {
  await ensureSchema();
  return db.withTransaction(async (c) => {
    await lockUser(c, guildId, userId);
    const del = await c.query('DELETE FROM gang_invites WHERE gang_id = $1 AND user_id = $2 AND guild_id = $3 AND expires_at > $4::bigint RETURNING gang_id', [gangId, userId, guildId, now]);
    if (del.rowCount === 0) return { ok: false, reason: 'gone' };
    const g = (await c.query('SELECT * FROM gangs WHERE id = $1 AND guild_id = $2 FOR UPDATE', [gangId, guildId])).rows[0];
    if (!g) return { ok: false, reason: 'gone' };
    if ((await gangsOf(c, guildId, userId)).length >= H.MAX_GANGS_PER_USER) return { ok: false, reason: 'limit' };
    if ((await membersOf(c, gangId)).length >= H.MAX_GANG_MEMBERS) return { ok: false, reason: 'full' };
    await c.query('INSERT INTO gang_members (gang_id, guild_id, user_id, joined_at) VALUES ($1, $2, $3, $4::bigint)', [gangId, guildId, userId, now]);
    return { ok: true, name: g.name };
  });
}

const declineInvite = async (guildId, userId, gangId) => {
  await ensureSchema();
  return (await db.raw.query('DELETE FROM gang_invites WHERE gang_id = $1 AND user_id = $2 AND guild_id = $3', [gangId, userId, guildId])).rowCount > 0;
};

// Wyjście z bandy. Lider, który wychodzi, przekazuje przywództwo najstarszemu członkowi; ostatnia osoba rozwiązuje bandę.
async function leave(guildId, userId, gangId) {
  await ensureSchema();
  return db.withTransaction(async (c) => {
    const g = (await c.query('SELECT * FROM gangs WHERE id = $1 AND guild_id = $2 FOR UPDATE', [gangId, guildId])).rows[0];
    if (!g) return { ok: false, reason: 'gone' };
    const del = await c.query('DELETE FROM gang_members WHERE gang_id = $1 AND user_id = $2', [gangId, userId]);
    if (del.rowCount === 0) return { ok: false, reason: 'not_member' };
    const rest = await membersOf(c, gangId);
    if (rest.length === 0) {
      await c.query('DELETE FROM gang_invites WHERE gang_id = $1', [gangId]);
      await c.query('DELETE FROM gangs WHERE id = $1', [gangId]);
      return { ok: true, disbanded: true, name: g.name };
    }
    let newLeader = null;
    if (g.leader_id === userId) {
      newLeader = rest[0].userId;
      await c.query('UPDATE gangs SET leader_id = $2 WHERE id = $1', [gangId, newLeader]);
    }
    return { ok: true, name: g.name, newLeader };
  });
}

async function kick(guildId, leaderId, gangId, targetId) {
  await ensureSchema();
  return db.withTransaction(async (c) => {
    const g = (await c.query('SELECT * FROM gangs WHERE id = $1 AND guild_id = $2 FOR UPDATE', [gangId, guildId])).rows[0];
    if (!g || g.leader_id !== leaderId) return { ok: false, reason: 'not_leader' };
    if (targetId === leaderId) return { ok: false, reason: 'self' };
    const del = await c.query('DELETE FROM gang_members WHERE gang_id = $1 AND user_id = $2', [gangId, targetId]);
    return del.rowCount ? { ok: true, name: g.name } : { ok: false, reason: 'not_member' };
  });
}

async function disband(guildId, leaderId, gangId) {
  await ensureSchema();
  return db.withTransaction(async (c) => {
    const g = (await c.query('SELECT * FROM gangs WHERE id = $1 AND guild_id = $2 FOR UPDATE', [gangId, guildId])).rows[0];
    if (!g || g.leader_id !== leaderId) return { ok: false, reason: 'not_leader' };
    await c.query('DELETE FROM gang_members WHERE gang_id = $1', [gangId]);
    await c.query('DELETE FROM gang_invites WHERE gang_id = $1', [gangId]);
    await c.query('DELETE FROM gangs WHERE id = $1', [gangId]);
    return { ok: true, name: g.name };
  });
}

// ---------------- NAPAD ----------------
// Start: sprawdza poziomy, areszt, limity dzienne i skład ekipy, zabiera przedmioty (liderowi/startującemu) i zlicza napad
// każdemu uczestnikowi, wszystko w jednej transakcji. Zwraca { ok: true, runId } albo { ok: false, reason, ... }:
//   unknown | players (zła liczba osób) | not_member (+userId) | level (+userId, need) | jail (+userId, until) | cap (+userId) | items (+missing: {id: brakuje})
async function startRun({ guildId, heistId, leaderId, playerIds, gangId = null, now = Date.now() }) {
  await ensureSchema();
  const heist = H.HEISTS[heistId];
  if (!heist) return { ok: false, reason: 'unknown' };
  const players = [...new Set(playerIds)];
  if (!players.includes(leaderId)) players.unshift(leaderId);
  if (players.length < heist.min || players.length > heist.max) return { ok: false, reason: 'players', min: heist.min, max: heist.max };

  return db.withTransaction(async (c) => {
    const sorted = [...players].sort(); // stała kolejność blokad: bez zakleszczeń
    for (const u of sorted) await lockUser(c, guildId, u);

    if (players.length > 1 || gangId) {
      if (!gangId) return { ok: false, reason: 'players', min: heist.min, max: heist.max };
      const members = new Set((await membersOf(c, gangId)).map((m) => m.userId));
      for (const u of players) if (!members.has(u)) return { ok: false, reason: 'not_member', userId: u };
    }
    for (const u of sorted) {
      const row = await readProfile(c, guildId, u, now);
      const lvl = Number((await c.query('SELECT level FROM user_levels WHERE guild_id = $1 AND user_id = $2', [guildId, u])).rows[0]?.level ?? 0);
      if (lvl < heist.minLevel) return { ok: false, reason: 'level', userId: u, need: heist.minLevel };
      if (Number(row.jail_until) > now) return { ok: false, reason: 'jail', userId: u, until: Number(row.jail_until) };
      if (row.heists_today >= H.DAILY_LIMIT) return { ok: false, reason: 'cap', userId: u };
    }
    // przedmioty: najpierw sprawdzamy wszystko, potem zabieramy (brak = nic nie przepada)
    const have = await c.query('SELECT item_id, quantity FROM inventory WHERE guild_id = $1 AND user_id = $2 AND item_id = ANY($3::text[])', [guildId, leaderId, Object.keys(heist.items)]);
    const owned = Object.fromEntries(have.rows.map((r) => [r.item_id, Number(r.quantity)]));
    const missing = {};
    for (const [id, n] of Object.entries(heist.items)) if ((owned[id] ?? 0) < n) missing[id] = n - (owned[id] ?? 0);
    if (Object.keys(missing).length) return { ok: false, reason: 'items', missing };
    for (const [id, n] of Object.entries(heist.items)) {
      if (!(await inv.removeItem(c, guildId, leaderId, id, n))) return { ok: false, reason: 'items', missing: { [id]: n } };
    }
    await c.query('UPDATE heist_profiles SET heists_today = heists_today + 1 WHERE guild_id = $1 AND user_id = ANY($2::text[])', [guildId, players]);
    const run = await c.query(
      'INSERT INTO heist_runs (guild_id, heist_id, gang_id, leader_id, players, started_at) VALUES ($1, $2, $3, $4, $5, $6::bigint) RETURNING id',
      [guildId, heistId, gangId, leaderId, JSON.stringify(players), now],
    );
    return { ok: true, runId: Number(run.rows[0].id), players };
  });
}

// Rozliczenie napadu. results: { [userId]: { hits, rounds, stagesPassed: bool } } (dla etapów danego gracza).
// Sukces = wszyscy zaliczyli swoje etapy. Sukces: każdy dostaje łup (zależny od jego skuteczności). Porażka: kara (grzywna + areszt)
// dla tych, którzy nie zaliczyli etapu; pozostali nie dostają nic (przedmioty i tak przepadły).
// Zwraca { ok: true, success, players: { [userId]: { loot, fine, jailUntil, balance, passed } } } albo { ok: false, reason: 'gone' }
async function settleRun({ guildId, runId, results, now = Date.now() }) {
  await ensureSchema();
  return db.withTransaction(async (c) => {
    const run = (await c.query("SELECT * FROM heist_runs WHERE id = $1 AND guild_id = $2 AND status = 'active' FOR UPDATE", [runId, guildId])).rows[0];
    if (!run) return { ok: false, reason: 'gone' };
    const heist = H.HEISTS[run.heist_id];
    const players = JSON.parse(run.players);
    const success = players.every((u) => results[u]?.stagesPassed);
    const out = {};
    for (const u of [...players].sort()) {
      const r = results[u] ?? { hits: 0, rounds: 1, stagesPassed: false };
      const entry = { passed: Boolean(r.stagesPassed), loot: 0, fine: 0, jailUntil: 0, balance: null };
      if (success) {
        entry.loot = H.lootFor(heist, r.rounds ? r.hits / r.rounds : 0, players.length, String(u) === String(run.leader_id));
        entry.balance = await db.applyCredit(c, guildId, u, entry.loot, `crime_${heist.id}`, true);
      } else if (!r.stagesPassed) {
        const acc = await c.query('SELECT balance FROM economy_accounts WHERE guild_id = $1 AND user_id = $2 FOR UPDATE', [guildId, u]);
        const balance = Number(acc.rows[0]?.balance ?? 0);
        entry.fine = H.fineFor(heist, balance);
        if (entry.fine > 0) {
          const nb = Number((await c.query('UPDATE economy_accounts SET balance = balance - $3::bigint WHERE guild_id = $1 AND user_id = $2 RETURNING balance', [guildId, u, entry.fine])).rows[0].balance);
          await c.query(
            `INSERT INTO economy_transactions (guild_id, user_id, amount, balance_after, reason, created_at) VALUES ($1, $2, $3::bigint, $4::bigint, 'crime_fine', $5::bigint)`,
            [guildId, u, -entry.fine, nb, now],
          );
          entry.balance = nb;
        } else entry.balance = balance;
        if (heist.jail > 0) {
          entry.jailUntil = now + heist.jail * 60_000;
          await c.query('UPDATE heist_profiles SET jail_until = GREATEST(jail_until, $3::bigint) WHERE guild_id = $1 AND user_id = $2', [guildId, u, entry.jailUntil]);
        }
      }
      out[u] = entry;
    }
    await c.query("UPDATE heist_runs SET status = $2, closed_at = $3::bigint WHERE id = $1", [runId, success ? 'success' : 'failed', now]);
    return { ok: true, success, heist, players: out };
  });
}

// Napady porzucone w trakcie (restart bota itp.) zamykamy jako 'abandoned' (przedmioty przepadły)
async function sweepStale(now = Date.now()) {
  await ensureSchema();
  return (await db.raw.query("UPDATE heist_runs SET status = 'abandoned', closed_at = $1::bigint WHERE status = 'active' AND started_at < $2::bigint", [now, now - 30 * 60_000])).rowCount;
}

module.exports = {
  ensureSchema, dayKey, getProfile, jailUntil, validName, cleanName,
  getMyGangs, createGang, invite, getInvites, acceptInvite, declineInvite, leave, kick, disband,
  startRun, settleRun, sweepStale,
};
