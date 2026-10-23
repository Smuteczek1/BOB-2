const { Pool } = require('pg');

// Zwraca datę kalendarzową (YYYY-MM-DD) wg czasu polskiego, niezależnie
// od strefy czasowej ustawionej na serwerze hostującym bota.
function getWarsawDateString(timestamp) {
  const date = timestamp ? new Date(Number(timestamp)) : new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(date); // np. "2026-08-15"
}

// Utworzenie puli połączeń do bazy PostgreSQL/Supabase
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// Pomocnicze funkcje do wykonywania zapytań SQL
async function query(text, params) {
  return await pool.query(text, params);
}

async function queryOne(text, params) {
  const res = await pool.query(text, params);
  return res.rows[0] || null;
}

async function queryMany(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}

// Wykonuje kilka zapytań w jednej transakcji: albo przejdą wszystkie, albo żadne.
// Używane tam, gdzie zmieniamy saldo i zapisujemy wpis w dzienniku jednocześnie.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    throw err;
  } finally {
    client.release();
  }
}

// Dopisuje monety na konto (tworzy konto, jeśli go nie ma) i opcjonalnie zapisuje wpis w dzienniku.
// Zwraca nowe saldo jako liczbę.
async function applyCredit(client, guildId, userId, amount, reason, ledger) {
  const res = await client.query(`
    INSERT INTO economy_accounts (guild_id, user_id, balance, total_earned, created_at)
    VALUES ($1, $2, $3::bigint, $3::bigint, $4::bigint)
    ON CONFLICT (guild_id, user_id) DO UPDATE
      SET balance = economy_accounts.balance + $3::bigint,
          total_earned = economy_accounts.total_earned + $3::bigint
    RETURNING balance
  `, [guildId, userId, amount, Date.now()]);
  const balance = Number(res.rows[0].balance);

  if (ledger) {
    await client.query(`
      INSERT INTO economy_transactions (guild_id, user_id, amount, balance_after, reason, created_at)
      VALUES ($1, $2, $3::bigint, $4::bigint, $5, $6::bigint)
    `, [guildId, userId, amount, balance, reason, Date.now()]);
  }
  return balance;
}

// Inicjalizacja struktur bazy danych
// ============================================================
//  RESET DANYCH - rejestr "celów" resetu
//  Każdy cel ma dwie funkcje: preview (ile danych zostanie dotkniętych) i apply (wykonanie, w transakcji).
//  userId = null oznacza CAŁY serwer. Gdy dojdzie nowa funkcja (np. ekwipunek ze sklepu),
//  wystarczy dopisać tu kolejny wpis i etykietę w commands/reset.js, reszta zadziała sama.
// ============================================================
const RESET_TARGETS = {
  inventory: {
    async preview(guildId, userId) {
      const res = await pool.query(`
        SELECT COUNT(DISTINCT user_id)::int AS n, COALESCE(SUM(quantity), 0)::bigint AS total
        FROM inventory
        WHERE guild_id = $1 AND ($2::text IS NULL OR user_id = $2) AND quantity > 0
      `, [guildId, userId]);
      return { people: res.rows[0].n, total: Number(res.rows[0].total) };
    },
    async apply(client, guildId, userId) {
      const rows = (await client.query(`
        SELECT user_id, item_id, quantity FROM inventory
        WHERE guild_id = $1 AND ($2::text IS NULL OR user_id = $2) FOR UPDATE
      `, [guildId, userId])).rows;
      for (const table of ['inventory', 'user_boosts', 'user_armed', 'item_daily_use']) {
        await client.query(`DELETE FROM ${table} WHERE guild_id = $1 AND ($2::text IS NULL OR user_id = $2)`, [guildId, userId]);
      }
      return {
        userIds: [...new Set(rows.map((r) => r.user_id))],
        backup: rows.map((r) => ({ type: 'ekwipunek', userId: r.user_id, a: r.quantity, b: r.item_id })),
      };
    },
  },


  coins: {
    async preview(guildId, userId) {
      const res = await pool.query(`
        SELECT COUNT(*)::int AS n, COALESCE(SUM(balance), 0)::bigint AS total
        FROM economy_accounts
        WHERE guild_id = $1 AND ($2::text IS NULL OR user_id = $2) AND (balance > 0 OR total_earned > 0)
      `, [guildId, userId]);
      return { people: res.rows[0].n, total: Number(res.rows[0].total) };
    },
    async apply(client, guildId, userId) {
      const rows = (await client.query(`
        SELECT user_id, balance, total_earned FROM economy_accounts
        WHERE guild_id = $1 AND ($2::text IS NULL OR user_id = $2) AND (balance > 0 OR total_earned > 0)
        FOR UPDATE
      `, [guildId, userId])).rows;

      // Zostawiamy ślad w dzienniku: kto stracił ile i dlaczego
      for (const r of rows) {
        const balance = Number(r.balance);
        if (balance > 0) {
          await client.query(`
            INSERT INTO economy_transactions (guild_id, user_id, amount, balance_after, reason, created_at)
            VALUES ($1, $2, $3::bigint, 0, 'reset', $4::bigint)
          `, [guildId, r.user_id, -balance, Date.now()]);
        }
      }

      await client.query(`
        UPDATE economy_accounts SET balance = 0, total_earned = 0
        WHERE guild_id = $1 AND ($2::text IS NULL OR user_id = $2) AND (balance > 0 OR total_earned > 0)
      `, [guildId, userId]);

      return {
        userIds: rows.map((r) => r.user_id),
        backup: rows.map((r) => ({ type: 'monety', userId: r.user_id, a: Number(r.balance), b: Number(r.total_earned) })),
      };
    },
  },

  xp: {
    async preview(guildId, userId) {
      const res = await pool.query(`
        SELECT COUNT(*)::int AS n, COALESCE(SUM(xp), 0)::bigint AS total
        FROM user_levels
        WHERE guild_id = $1 AND ($2::text IS NULL OR user_id = $2) AND (xp > 0 OR level > 0)
      `, [guildId, userId]);
      return { people: res.rows[0].n, total: Number(res.rows[0].total) };
    },
    async apply(client, guildId, userId) {
      const rows = (await client.query(`
        SELECT user_id, xp, level FROM user_levels
        WHERE guild_id = $1 AND ($2::text IS NULL OR user_id = $2) AND (xp > 0 OR level > 0)
        FOR UPDATE
      `, [guildId, userId])).rows;

      // last_daily_at zostaje nietknięte, żeby reset EXP nie pozwalał odebrać dziennej nagrody drugi raz
      await client.query(`
        UPDATE user_levels SET xp = 0, level = 0
        WHERE guild_id = $1 AND ($2::text IS NULL OR user_id = $2) AND (xp > 0 OR level > 0)
      `, [guildId, userId]);

      return {
        userIds: rows.map((r) => r.user_id),
        backup: rows.map((r) => ({ type: 'exp', userId: r.user_id, a: r.xp, b: r.level })),
      };
    },
  },
};

async function initDb() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS guild_config (
        guild_id TEXT PRIMARY KEY,
        hub_channel_id TEXT,
        stats_channel_id TEXT,
        leaderboard_message_id TEXT,
        suggestions_channel_id TEXT,
        suggestions_prompt_message_id TEXT,
        suggestions_list_channel_id TEXT,
        suggestions_create_channel_id TEXT,
        levels_channel_id TEXT,
        created_at BIGINT
      );

      CREATE TABLE IF NOT EXISTS temp_channels (
        channel_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        creator_id TEXT,
        started_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id SERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        creator_id TEXT,
        started_at BIGINT NOT NULL,
        ended_at BIGINT NOT NULL,
        duration_seconds INT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_guild ON sessions(guild_id);

      CREATE TABLE IF NOT EXISTS role_panels (
        id SERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT,
        mode TEXT NOT NULL,
        title TEXT,
        description TEXT,
        created_at BIGINT
      );

      CREATE TABLE IF NOT EXISTS role_panel_items (
        id SERIAL PRIMARY KEY,
        panel_id INT NOT NULL REFERENCES role_panels(id) ON DELETE CASCADE,
        role_id TEXT NOT NULL,
        emoji_key TEXT,
        emoji_raw TEXT,
        label TEXT,
        custom_id TEXT,
        position INT
      );
      CREATE INDEX IF NOT EXISTS idx_role_panel_items_panel ON role_panel_items(panel_id);

      CREATE TABLE IF NOT EXISTS user_levels (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        xp INT NOT NULL DEFAULT 0,
        level INT NOT NULL DEFAULT 0,
        last_text_xp_at BIGINT,
        last_daily_at BIGINT,
        PRIMARY KEY (guild_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS level_roles (
        guild_id TEXT NOT NULL,
        level INT NOT NULL,
        role_id TEXT NOT NULL,
        PRIMARY KEY (guild_id, level)
      );

      CREATE TABLE IF NOT EXISTS suggestion_boards (
        id SERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        list_channel_id TEXT NOT NULL,
        create_channel_id TEXT NOT NULL,
        prompt_message_id TEXT,
        prompt_text TEXT,
        button_label TEXT,
        upvote_emoji TEXT,
        downvote_emoji TEXT,
        created_at BIGINT
      );
      CREATE INDEX IF NOT EXISTS idx_suggestion_boards_guild ON suggestion_boards(guild_id);
      CREATE INDEX IF NOT EXISTS idx_suggestion_boards_create_channel ON suggestion_boards(create_channel_id);

      CREATE TABLE IF NOT EXISTS rule_points (
        id SERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        position INT NOT NULL DEFAULT 0,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        details TEXT,
        message_id TEXT,
        created_at BIGINT
      );
      CREATE INDEX IF NOT EXISTS idx_rule_points_guild ON rule_points(guild_id);

      CREATE TABLE IF NOT EXISTS ticket_types (
        id SERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        emoji TEXT,
        description TEXT,
        position INT NOT NULL DEFAULT 0,
        created_at BIGINT
      );
      CREATE INDEX IF NOT EXISTS idx_ticket_types_guild ON ticket_types(guild_id);

      CREATE TABLE IF NOT EXISTS tickets (
        id SERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        type_id INT REFERENCES ticket_types(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'open',
        description TEXT,
        welcome_message_id TEXT,
        message_count INT NOT NULL DEFAULT 0,
        opened_at BIGINT NOT NULL,
        closed_at BIGINT,
        closed_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tickets_guild ON tickets(guild_id);
      CREATE INDEX IF NOT EXISTS idx_tickets_channel ON tickets(channel_id);
      CREATE INDEX IF NOT EXISTS idx_tickets_user_status ON tickets(guild_id, user_id, status);
    `);

    // Bezpieczne dodanie kolumny last_daily_at, jeśli tabela user_levels już istniała bez niej
    await query(`
      ALTER TABLE user_levels ADD COLUMN IF NOT EXISTS last_daily_at BIGINT;
    `);

    // Bezpieczne dodanie kolumn systemu powitań / pożegnań / roli startowej,
    // jeśli tabela guild_config już istniała bez nich
    await query(`
      ALTER TABLE guild_config
        ADD COLUMN IF NOT EXISTS welcome_channel_id TEXT,
        ADD COLUMN IF NOT EXISTS welcome_message TEXT,
        ADD COLUMN IF NOT EXISTS goodbye_channel_id TEXT,
        ADD COLUMN IF NOT EXISTS goodbye_message TEXT,
        ADD COLUMN IF NOT EXISTS starter_role_id TEXT,
        ADD COLUMN IF NOT EXISTS starter_role_replace_on_verify BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS verify_channel_id TEXT,
        ADD COLUMN IF NOT EXISTS verify_message_id TEXT,
        ADD COLUMN IF NOT EXISTS verify_role_id TEXT,
        ADD COLUMN IF NOT EXISTS verify_rules_text TEXT,
        ADD COLUMN IF NOT EXISTS verify_rules_title TEXT,
        ADD COLUMN IF NOT EXISTS verify_button_label TEXT,
        ADD COLUMN IF NOT EXISTS verify_intro_comment TEXT,
        ADD COLUMN IF NOT EXISTS verify_accept_title TEXT,
        ADD COLUMN IF NOT EXISTS verify_accept_text TEXT,
        ADD COLUMN IF NOT EXISTS verify_accept_button_label TEXT,
        ADD COLUMN IF NOT EXISTS verify_accept_comment TEXT,
        ADD COLUMN IF NOT EXISTS verify_emoji TEXT,
        ADD COLUMN IF NOT EXISTS verify_intro_message_id TEXT,
        ADD COLUMN IF NOT EXISTS ticket_category_id TEXT,
        ADD COLUMN IF NOT EXISTS ticket_support_role_id TEXT,
        ADD COLUMN IF NOT EXISTS ticket_panel_channel_id TEXT,
        ADD COLUMN IF NOT EXISTS ticket_panel_message_id TEXT,
        ADD COLUMN IF NOT EXISTS ticket_limit_per_user INT DEFAULT 1,
        ADD COLUMN IF NOT EXISTS ticket_panel_title TEXT,
        ADD COLUMN IF NOT EXISTS ticket_panel_text TEXT,
        ADD COLUMN IF NOT EXISTS ticket_panel_placeholder TEXT;
    `);

    // Bezpieczne dodanie nowych kolumn systemu ticketów, jeśli tabela tickets
    // już istniała bez nich (np. na już działającym bocie)
    await query(`
      ALTER TABLE tickets
        ADD COLUMN IF NOT EXISTS description TEXT,
        ADD COLUMN IF NOT EXISTS welcome_message_id TEXT,
        ADD COLUMN IF NOT EXISTS message_count INT NOT NULL DEFAULT 0;
    `);

    // --- Ekonomia: konta i dziennik transakcji ---
    await query(`
      CREATE TABLE IF NOT EXISTS economy_accounts (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        balance BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
        total_earned BIGINT NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS economy_transactions (
        id BIGSERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        amount BIGINT NOT NULL,
        balance_after BIGINT NOT NULL,
        reason TEXT NOT NULL,
        created_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_econ_tx_user ON economy_transactions(guild_id, user_id, created_at DESC);
    `);

    // --- Sklep i ekwipunek ---
    await query(`
      CREATE TABLE IF NOT EXISTS inventory (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        quantity INT NOT NULL CHECK (quantity >= 0),
        PRIMARY KEY (guild_id, user_id, item_id)
      );

      CREATE TABLE IF NOT EXISTS user_boosts (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        family TEXT NOT NULL,
        value INT NOT NULL,
        expires_at BIGINT NOT NULL,
        PRIMARY KEY (guild_id, user_id, family)
      );

      CREATE TABLE IF NOT EXISTS user_armed (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        item_id TEXT NOT NULL,
        armed_at BIGINT NOT NULL,
        PRIMARY KEY (guild_id, user_id, kind)
      );

      CREATE TABLE IF NOT EXISTS item_daily_use (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        use_date TEXT NOT NULL,
        PRIMARY KEY (guild_id, user_id, item_id)
      );
    `);

    console.log('✅ Baza danych Supabase (PostgreSQL) została pomyślnie zainicjalizowana.');
  } catch (err) {
    console.error('❌ Błąd podczas inicjalizacji bazy PostgreSQL:', err);
  }
}

initDb();

module.exports = {
  raw: pool,
  withTransaction,
  applyCredit,

  // --- Konfiguracja serwera ---
  async getGuildConfig(guildId) {
    return await queryOne('SELECT * FROM guild_config WHERE guild_id = $1', [guildId]);
  },

  async upsertGuildConfig(guildId, { hubChannelId, statsChannelId }) {
    const existing = await this.getGuildConfig(guildId);
    if (existing) {
      await query(`
        UPDATE guild_config
        SET hub_channel_id = COALESCE($1, hub_channel_id),
            stats_channel_id = COALESCE($2, stats_channel_id)
        WHERE guild_id = $3
      `, [hubChannelId ?? null, statsChannelId ?? null, guildId]);
    } else {
      await query(`
        INSERT INTO guild_config (guild_id, hub_channel_id, stats_channel_id, created_at)
        VALUES ($1, $2, $3, $4)
      `, [guildId, hubChannelId ?? null, statsChannelId ?? null, Date.now()]);
    }
  },

  async setLeaderboardMessageId(guildId, messageId) {
    await query('UPDATE guild_config SET leaderboard_message_id = $1 WHERE guild_id = $2', [messageId, guildId]);
  },

  // --- Kanały propozycji (stare) ---
  async setSuggestionsConfig(guildId, { listChannelId, createChannelId, promptMessageId }) {
    const existing = await this.getGuildConfig(guildId);
    if (existing) {
      await query(`
        UPDATE guild_config
        SET suggestions_list_channel_id = COALESCE($1, suggestions_list_channel_id),
            suggestions_create_channel_id = COALESCE($2, suggestions_create_channel_id),
            suggestions_prompt_message_id = COALESCE($3, suggestions_prompt_message_id)
        WHERE guild_id = $4
      `, [listChannelId ?? null, createChannelId ?? null, promptMessageId ?? null, guildId]);
    } else {
      await query(`
        INSERT INTO guild_config (guild_id, suggestions_list_channel_id, suggestions_create_channel_id, suggestions_prompt_message_id, created_at)
        VALUES ($1, $2, $3, $4, $5)
      `, [guildId, listChannelId ?? null, createChannelId ?? null, promptMessageId ?? null, Date.now()]);
    }
  },

  // --- Tablice propozycji ---
  async createSuggestionBoard(guildId, { listChannelId, createChannelId, promptText, buttonLabel, upvoteEmoji, downvoteEmoji }) {
    const res = await queryOne(`
      INSERT INTO suggestion_boards (guild_id, list_channel_id, create_channel_id, prompt_text, button_label, upvote_emoji, downvote_emoji, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [
      guildId,
      listChannelId,
      createChannelId,
      promptText ?? null,
      buttonLabel ?? null,
      upvoteEmoji ?? null,
      downvoteEmoji ?? null,
      Date.now(),
    ]);
    return res;
  },

  async setSuggestionBoardPromptMessageId(boardId, messageId) {
    const parsedId = parseInt(boardId, 10);
    if (isNaN(parsedId)) return;
    await query('UPDATE suggestion_boards SET prompt_message_id = $1 WHERE id = $2', [messageId, parsedId]);
  },

  async getSuggestionBoard(boardId) {
    const parsedId = parseInt(boardId, 10);
    if (isNaN(parsedId)) return null;
    return await queryOne('SELECT * FROM suggestion_boards WHERE id = $1', [parsedId]);
  },

  async listSuggestionBoards(guildId) {
    return await queryMany('SELECT * FROM suggestion_boards WHERE guild_id = $1 ORDER BY id', [guildId]);
  },

  async deleteSuggestionBoard(boardId) {
    const parsedId = parseInt(boardId, 10);
    if (isNaN(parsedId)) return;
    await query('DELETE FROM suggestion_boards WHERE id = $1', [parsedId]);
  },

  // --- Tymczasowe kanały głosowe ---
  async addTempChannel(channelId, guildId, creatorId) {
    await query(`
      INSERT INTO temp_channels (channel_id, guild_id, creator_id, started_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (channel_id) DO NOTHING
    `, [channelId, guildId, creatorId, Date.now()]);
  },

  async getTempChannel(channelId) {
    return await queryOne('SELECT * FROM temp_channels WHERE channel_id = $1', [channelId]);
  },

  async removeTempChannel(channelId) {
    await query('DELETE FROM temp_channels WHERE channel_id = $1', [channelId]);
  },

  async getAllTempChannels() {
    return await queryMany('SELECT * FROM temp_channels');
  },

  // --- Sesje ---
  async addSession(guildId, channelId, creatorId, startedAt, endedAt) {
    const durationSeconds = Math.max(0, Math.round((endedAt - startedAt) / 1000));
    await query(`
      INSERT INTO sessions (guild_id, channel_id, creator_id, started_at, ended_at, duration_seconds)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [guildId, channelId, creatorId, startedAt, endedAt, durationSeconds]);
    return durationSeconds;
  },

  async getTopAllTime(guildId, limit = 5) {
    return await queryMany(`
      SELECT * FROM sessions WHERE guild_id = $1
      ORDER BY duration_seconds DESC LIMIT $2
    `, [guildId, limit]);
  },

  async getTopThisMonth(guildId, limit = 5) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
    return await queryMany(`
      SELECT * FROM sessions
      WHERE guild_id = $1 AND started_at >= $2 AND started_at < $3
      ORDER BY duration_seconds DESC LIMIT $4
    `, [guildId, monthStart, monthEnd, limit]);
  },

  // --- Panele ról ---
  async createRolePanel(guildId, { channelId, mode, title, description }) {
    return await queryOne(`
      INSERT INTO role_panels (guild_id, channel_id, mode, title, description, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [guildId, channelId, mode, title ?? null, description ?? null, Date.now()]);
  },

  async setRolePanelMessageId(panelId, messageId) {
    await query('UPDATE role_panels SET message_id = $1 WHERE id = $2', [messageId, panelId]);
  },

  async getRolePanel(panelId) {
    return await queryOne('SELECT * FROM role_panels WHERE id = $1', [panelId]);
  },

  async getRolePanelByMessageId(messageId) {
    return await queryOne('SELECT * FROM role_panels WHERE message_id = $1', [messageId]);
  },

  async listRolePanels(guildId) {
    return await queryMany('SELECT * FROM role_panels WHERE guild_id = $1 ORDER BY id', [guildId]);
  },

  async deleteRolePanel(panelId) {
    await query('DELETE FROM role_panel_items WHERE panel_id = $1', [panelId]);
    await query('DELETE FROM role_panels WHERE id = $1', [panelId]);
  },

  async addRolePanelItem(panelId, { roleId, emojiKey, emojiRaw, label, customId }) {
    const countRow = await queryOne('SELECT COUNT(*)::int as c FROM role_panel_items WHERE panel_id = $1', [panelId]);
    const position = countRow ? countRow.c : 0;
    return await queryOne(`
      INSERT INTO role_panel_items (panel_id, role_id, emoji_key, emojiRaw, label, custom_id, position)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [panelId, roleId, emojiKey ?? null, emojiRaw ?? null, label ?? null, customId ?? null, position]);
  },

  async removeRolePanelItemByRole(panelId, roleId) {
    await query('DELETE FROM role_panel_items WHERE panel_id = $1 AND role_id = $2', [panelId, roleId]);
  },

  async getRolePanelItems(panelId) {
    return await queryMany('SELECT * FROM role_panel_items WHERE panel_id = $1 ORDER BY position', [panelId]);
  },

  async getRolePanelItemByEmojiKey(panelId, emojiKey) {
    return await queryOne('SELECT * FROM role_panel_items WHERE panel_id = $1 AND emoji_key = $2', [panelId, emojiKey]);
  },

  async getRolePanelItemByCustomId(customId) {
    return await queryOne('SELECT * FROM role_panel_items WHERE custom_id = $1', [customId]);
  },

  // --- Kanał poziomów ---
  async setLevelsChannel(guildId, channelId) {
    const existing = await this.getGuildConfig(guildId);
    if (existing) {
      await query('UPDATE guild_config SET levels_channel_id = $1 WHERE guild_id = $2', [channelId, guildId]);
    } else {
      await query(`
        INSERT INTO guild_config (guild_id, levels_channel_id, created_at)
        VALUES ($1, $2, $3)
      `, [guildId, channelId, Date.now()]);
    }
  },

  // --- System EXP ---
  async getUserLevel(guildId, userId) {
    return await queryOne('SELECT * FROM user_levels WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
  },

  async canGetTextXp(guildId, userId, cooldownMs) {
    const row = await this.getUserLevel(guildId, userId);
    if (!row || !row.last_text_xp_at) return true;
    return Date.now() - Number(row.last_text_xp_at) >= cooldownMs;
  },

  async addXp(guildId, userId, amount, source, computeLevel) {
    const existing = await this.getUserLevel(guildId, userId);
    const now = Date.now();

    if (!existing) {
      await query(`
        INSERT INTO user_levels (guild_id, user_id, xp, level, last_text_xp_at)
        VALUES ($1, $2, $3, 0, $4)
      `, [guildId, userId, amount, source === 'text' ? now : null]);
    } else if (source === 'text') {
      await query(`
        UPDATE user_levels SET xp = xp + $1, last_text_xp_at = $2 WHERE guild_id = $3 AND user_id = $4
      `, [amount, now, guildId, userId]);
    } else {
      await query(`
        UPDATE user_levels SET xp = xp + $1 WHERE guild_id = $2 AND user_id = $3
      `, [amount, guildId, userId]);
    }

    const row = await this.getUserLevel(guildId, userId);
    const oldLevel = row.level;
    const newLevel = computeLevel(row.xp);

    if (newLevel !== oldLevel) {
      await query('UPDATE user_levels SET level = $1 WHERE guild_id = $2 AND user_id = $3', [newLevel, guildId, userId]);
    }

    return { oldLevel, newLevel, xp: row.xp };
  },

  // Wszyscy użytkownicy z XP na serwerze (do eksportu / kopii zapasowej)
  async getAllUserLevels(guildId) {
    return await queryMany(
      'SELECT user_id, xp, level FROM user_levels WHERE guild_id = $1 ORDER BY xp DESC',
      [guildId],
    );
  },

  async getLeaderboardXp(guildId, limit = 10) {
    return await queryMany(`
      SELECT * FROM user_levels WHERE guild_id = $1 ORDER BY xp DESC LIMIT $2
    `, [guildId, limit]);
  },

  // --- NAGRODA DZIENNA (Daily XP) ---
  async canClaimDaily(guildId, userId) {
    const row = await this.getUserLevel(guildId, userId);
    if (!row || !row.last_daily_at) return true;

    const todayWarsaw = getWarsawDateString();
    const lastClaimWarsaw = getWarsawDateString(row.last_daily_at);

    return todayWarsaw !== lastClaimWarsaw;
  },

  async setDailyClaimed(guildId, userId) {
    const now = Date.now();
    const existing = await this.getUserLevel(guildId, userId);

    if (!existing) {
      await query(`
        INSERT INTO user_levels (guild_id, user_id, xp, level, last_daily_at)
        VALUES ($1, $2, 0, 0, $3)
      `, [guildId, userId, now]);
    } else {
      await query(`
        UPDATE user_levels SET last_daily_at = $1 WHERE guild_id = $2 AND user_id = $3
      `, [now, guildId, userId]);
    }
  },

  // --- RESET DANYCH ---
  RESET_TARGET_KEYS: Object.keys(RESET_TARGETS),

  // Podgląd: ile osób i ile "wartości" zostanie dotkniętych (nic nie zmienia)
  async previewReset(guildId, userId, keys) {
    const out = {};
    for (const key of keys) out[key] = await RESET_TARGETS[key].preview(guildId, userId);
    return out;
  },

  // Wykonuje reset wybranych celów w JEDNEJ transakcji (albo wszystko, albo nic).
  // Zwraca dla każdego celu: userIds (kogo dotknęło) i backup (co było przed resetem).
  async resetData(guildId, userId, keys) {
    return await withTransaction(async (client) => {
      const out = {};
      for (const key of keys) out[key] = await RESET_TARGETS[key].apply(client, guildId, userId);
      return out;
    });
  },

  // --- EKONOMIA ---
  async getEconomyAccount(guildId, userId) {
    return await queryOne('SELECT * FROM economy_accounts WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
  },

  // Dodaje monety i zapisuje wpis w dzienniku (dla zdarzeń "jednorazowych": nagrody, zakupy, wygrane itd.)
  async addCoins(guildId, userId, amount, reason) {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('addCoins: kwota musi być dodatnią liczbą całkowitą');
    return await withTransaction((client) => applyCredit(client, guildId, userId, amount, reason, true));
  },

  // Odejmuje monety TYLKO jeśli saldo wystarcza (jedno zapytanie, więc dwa szybkie kliknięcia nie wydadzą tych samych monet).
  // Zwraca nowe saldo albo null, gdy brakuje środków.
  async spendCoins(guildId, userId, amount, reason) {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('spendCoins: kwota musi być dodatnią liczbą całkowitą');
    return await withTransaction(async (client) => {
      const res = await client.query(`
        UPDATE economy_accounts SET balance = balance - $3::bigint
        WHERE guild_id = $1 AND user_id = $2 AND balance >= $3::bigint
        RETURNING balance
      `, [guildId, userId, amount]);
      if (res.rowCount === 0) return null;

      const balance = Number(res.rows[0].balance);
      await client.query(`
        INSERT INTO economy_transactions (guild_id, user_id, amount, balance_after, reason, created_at)
        VALUES ($1, $2, $3::bigint, $4::bigint, $5, $6::bigint)
      `, [guildId, userId, -amount, balance, reason, Date.now()]);
      return balance;
    });
  },

  async getRecentTransactions(guildId, userId, limit = 5) {
    return await queryMany(`
      SELECT amount, balance_after, reason, created_at
      FROM economy_transactions
      WHERE guild_id = $1 AND user_id = $2
      ORDER BY created_at DESC, id DESC
      LIMIT $3
    `, [guildId, userId, limit]);
  },

  // Dzienna nagroda: sprawdzenie "czy już odebrano dziś (czas polski)" i wypłata w JEDNEJ transakcji.
  // Drugie równoległe kliknięcie czeka na pierwsze i dostaje claimed: false.
  async claimDailyCoins(guildId, userId, amount) {
    return await withTransaction(async (client) => {
      await client.query(`
        INSERT INTO user_levels (guild_id, user_id, xp, level)
        VALUES ($1, $2, 0, 0)
        ON CONFLICT (guild_id, user_id) DO NOTHING
      `, [guildId, userId]);

      const claim = await client.query(`
        UPDATE user_levels SET last_daily_at = $3::bigint
        WHERE guild_id = $1 AND user_id = $2
          AND (
            last_daily_at IS NULL
            OR (to_timestamp(last_daily_at / 1000.0) AT TIME ZONE 'Europe/Warsaw')::date
               <> (now() AT TIME ZONE 'Europe/Warsaw')::date
          )
        RETURNING user_id
      `, [guildId, userId, Date.now()]);

      if (claim.rowCount === 0) return { claimed: false };

      const balance = await applyCredit(client, guildId, userId, amount, 'daily', true);
      return { claimed: true, balance };
    });
  },

  // --- Powitania ---
  async setWelcomeConfig(guildId, { channelId, message }) {
    const existing = await this.getGuildConfig(guildId);
    if (existing) {
      await query(`
        UPDATE guild_config
        SET welcome_channel_id = $1,
            welcome_message = $2
        WHERE guild_id = $3
      `, [channelId ?? null, message !== undefined ? message : existing.welcome_message, guildId]);
    } else {
      await query(`
        INSERT INTO guild_config (guild_id, welcome_channel_id, welcome_message, created_at)
        VALUES ($1, $2, $3, $4)
      `, [guildId, channelId ?? null, message ?? null, Date.now()]);
    }
  },

  // --- Pożegnania ---
  async setGoodbyeConfig(guildId, { channelId, message }) {
    const existing = await this.getGuildConfig(guildId);
    if (existing) {
      await query(`
        UPDATE guild_config
        SET goodbye_channel_id = $1,
            goodbye_message = $2
        WHERE guild_id = $3
      `, [channelId ?? null, message !== undefined ? message : existing.goodbye_message, guildId]);
    } else {
      await query(`
        INSERT INTO guild_config (guild_id, goodbye_channel_id, goodbye_message, created_at)
        VALUES ($1, $2, $3, $4)
      `, [guildId, channelId ?? null, message ?? null, Date.now()]);
    }
  },

  // --- Rola startowa ---
  async setStarterRoleConfig(guildId, { roleId, replaceOnVerify }) {
    const existing = await this.getGuildConfig(guildId);
    if (existing) {
      await query(`
        UPDATE guild_config
        SET starter_role_id = $1,
            starter_role_replace_on_verify = $2
        WHERE guild_id = $3
      `, [
        roleId ?? null,
        replaceOnVerify !== undefined ? replaceOnVerify : existing.starter_role_replace_on_verify,
        guildId,
      ]);
    } else {
      await query(`
        INSERT INTO guild_config (guild_id, starter_role_id, starter_role_replace_on_verify, created_at)
        VALUES ($1, $2, $3, $4)
      `, [guildId, roleId ?? null, replaceOnVerify ?? false, Date.now()]);
    }
  },

  // --- Regulamin / weryfikacja ---
  async setVerificationConfig(guildId, {
    channelId, roleId, rulesText, rulesTitle, buttonLabel, introComment,
    acceptTitle, acceptText, acceptButtonLabel, acceptComment,
  }) {
    const existing = await this.getGuildConfig(guildId);
    const pick = (val, fallback) => (val !== undefined ? val : fallback);

    if (existing) {
      await query(`
        UPDATE guild_config
        SET verify_channel_id = $1,
            verify_role_id = $2,
            verify_rules_text = $3,
            verify_rules_title = $4,
            verify_button_label = $5,
            verify_intro_comment = $6,
            verify_accept_title = $7,
            verify_accept_text = $8,
            verify_accept_button_label = $9,
            verify_accept_comment = $10
        WHERE guild_id = $11
      `, [
        channelId ?? null,
        roleId ?? null,
        pick(rulesText, existing.verify_rules_text),
        pick(rulesTitle, existing.verify_rules_title),
        pick(buttonLabel, existing.verify_button_label),
        pick(introComment, existing.verify_intro_comment),
        pick(acceptTitle, existing.verify_accept_title),
        pick(acceptText, existing.verify_accept_text),
        pick(acceptButtonLabel, existing.verify_accept_button_label),
        pick(acceptComment, existing.verify_accept_comment),
        guildId,
      ]);
    } else {
      await query(`
        INSERT INTO guild_config
          (guild_id, verify_channel_id, verify_role_id, verify_rules_text, verify_rules_title,
           verify_button_label, verify_intro_comment, verify_accept_title, verify_accept_text,
           verify_accept_button_label, verify_accept_comment, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `, [
        guildId,
        channelId ?? null,
        roleId ?? null,
        rulesText ?? null,
        rulesTitle ?? null,
        buttonLabel ?? null,
        introComment ?? null,
        acceptTitle ?? null,
        acceptText ?? null,
        acceptButtonLabel ?? null,
        acceptComment ?? null,
        Date.now(),
      ]);
    }
  },

  async setVerificationMessageId(guildId, messageId) {
    await query('UPDATE guild_config SET verify_message_id = $1 WHERE guild_id = $2', [messageId, guildId]);
  },

  async setVerificationMessageIds(guildId, { introMessageId, verifyMessageId }) {
    const existing = await this.getGuildConfig(guildId);
    await query(`
      UPDATE guild_config
      SET verify_intro_message_id = $1,
          verify_message_id = $2
      WHERE guild_id = $3
    `, [
      introMessageId !== undefined ? introMessageId : existing?.verify_intro_message_id,
      verifyMessageId !== undefined ? verifyMessageId : existing?.verify_message_id,
      guildId,
    ]);
  },

  // --- Punkty regulaminu ---
  async addRulePoint(guildId, { title, summary, details }) {
    const countRow = await queryOne('SELECT COUNT(*)::int as c FROM rule_points WHERE guild_id = $1', [guildId]);
    const position = countRow ? countRow.c : 0;
    return await queryOne(`
      INSERT INTO rule_points (guild_id, position, title, summary, details, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [guildId, position, title, summary, details ?? null, Date.now()]);
  },

  async getRulePoints(guildId) {
    return await queryMany('SELECT * FROM rule_points WHERE guild_id = $1 ORDER BY position', [guildId]);
  },

  async getRulePoint(id) {
    const parsedId = parseInt(id, 10);
    if (isNaN(parsedId)) return null;
    return await queryOne('SELECT * FROM rule_points WHERE id = $1', [parsedId]);
  },

  async updateRulePoint(id, { title, summary, details }) {
    const parsedId = parseInt(id, 10);
    if (isNaN(parsedId)) return;
    await query(`
      UPDATE rule_points SET title = $1, summary = $2, details = $3 WHERE id = $4
    `, [title, summary, details ?? null, parsedId]);
  },

  async deleteRulePoint(id) {
    const point = await this.getRulePoint(id);
    if (!point) return null;

    await query('DELETE FROM rule_points WHERE id = $1', [point.id]);

    // Przenumerowanie pozostałych pozycji, żeby nie zostały dziury w kolejności
    await query(`
      UPDATE rule_points AS rp
      SET position = sub.new_position
      FROM (
        SELECT id, ROW_NUMBER() OVER (ORDER BY position) - 1 AS new_position
        FROM rule_points WHERE guild_id = $1
      ) AS sub
      WHERE rp.id = sub.id
    `, [point.guild_id]);

    return point;
  },

  async setRulePointMessageId(id, messageId) {
    const parsedId = parseInt(id, 10);
    if (isNaN(parsedId)) return;
    await query('UPDATE rule_points SET message_id = $1 WHERE id = $2', [messageId, parsedId]);
  },

  async clearRulePointMessageIds(guildId) {
    await query('UPDATE rule_points SET message_id = NULL WHERE guild_id = $1', [guildId]);
  },

  // --- Drabinka ról za poziomy ---
  async setLevelRole(guildId, level, roleId) {
    await query(`
      INSERT INTO level_roles (guild_id, level, role_id) VALUES ($1, $2, $3)
      ON CONFLICT(guild_id, level) DO UPDATE SET role_id = EXCLUDED.role_id
    `, [guildId, level, roleId]);
  },

  async removeLevelRole(guildId, level) {
    await query('DELETE FROM level_roles WHERE guild_id = $1 AND level = $2', [guildId, level]);
  },

  async getLevelRoles(guildId) {
    return await queryMany('SELECT * FROM level_roles WHERE guild_id = $1 ORDER BY level DESC', [guildId]);
  },

  // --- Tickety: konfiguracja serwera ---
  async setTicketConfig(guildId, { categoryId, supportRoleId, limitPerUser }) {
    const existing = await this.getGuildConfig(guildId);
    if (existing) {
      await query(`
        UPDATE guild_config
        SET ticket_category_id = COALESCE($1, ticket_category_id),
            ticket_support_role_id = COALESCE($2, ticket_support_role_id),
            ticket_limit_per_user = COALESCE($3, ticket_limit_per_user)
        WHERE guild_id = $4
      `, [categoryId ?? null, supportRoleId ?? null, limitPerUser ?? null, guildId]);
    } else {
      await query(`
        INSERT INTO guild_config (guild_id, ticket_category_id, ticket_support_role_id, ticket_limit_per_user, created_at)
        VALUES ($1, $2, $3, $4, $5)
      `, [guildId, categoryId ?? null, supportRoleId ?? null, limitPerUser ?? 1, Date.now()]);
    }
  },

  async setTicketPanelConfig(guildId, { channelId, messageId, title, text, placeholder }) {
    const existing = await this.getGuildConfig(guildId);
    const pick = (val, fallback) => (val !== undefined ? val : fallback);

    if (existing) {
      await query(`
        UPDATE guild_config
        SET ticket_panel_channel_id = $1,
            ticket_panel_message_id = $2,
            ticket_panel_title = $3,
            ticket_panel_text = $4,
            ticket_panel_placeholder = $5
        WHERE guild_id = $6
      `, [
        pick(channelId, existing.ticket_panel_channel_id),
        pick(messageId, existing.ticket_panel_message_id),
        pick(title, existing.ticket_panel_title),
        pick(text, existing.ticket_panel_text),
        pick(placeholder, existing.ticket_panel_placeholder),
        guildId,
      ]);
    } else {
      await query(`
        INSERT INTO guild_config (guild_id, ticket_panel_channel_id, ticket_panel_message_id, ticket_panel_title, ticket_panel_text, ticket_panel_placeholder, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [guildId, channelId ?? null, messageId ?? null, title ?? null, text ?? null, placeholder ?? null, Date.now()]);
    }
  },

  // --- Typy ticketów ---
  async addTicketType(guildId, { name, color, emoji, description }) {
    const countRow = await queryOne('SELECT COUNT(*)::int as c FROM ticket_types WHERE guild_id = $1', [guildId]);
    const position = countRow ? countRow.c : 0;
    return await queryOne(`
      INSERT INTO ticket_types (guild_id, name, color, emoji, description, position, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [guildId, name, color, emoji ?? null, description ?? null, position, Date.now()]);
  },

  async getTicketTypes(guildId) {
    return await queryMany('SELECT * FROM ticket_types WHERE guild_id = $1 ORDER BY position', [guildId]);
  },

  async getTicketType(id) {
    const parsedId = parseInt(id, 10);
    if (isNaN(parsedId)) return null;
    return await queryOne('SELECT * FROM ticket_types WHERE id = $1', [parsedId]);
  },

  async getTicketTypeByName(guildId, name) {
    return await queryOne('SELECT * FROM ticket_types WHERE guild_id = $1 AND LOWER(name) = LOWER($2)', [guildId, name]);
  },

  async deleteTicketType(id) {
    const type = await this.getTicketType(id);
    if (!type) return null;

    await query('DELETE FROM ticket_types WHERE id = $1', [type.id]);

    // Przenumerowanie pozostałych pozycji, żeby nie zostały dziury w kolejności
    await query(`
      UPDATE ticket_types AS tt
      SET position = sub.new_position
      FROM (
        SELECT id, ROW_NUMBER() OVER (ORDER BY position) - 1 AS new_position
        FROM ticket_types WHERE guild_id = $1
      ) AS sub
      WHERE tt.id = sub.id
    `, [type.guild_id]);

    return type;
  },

  // --- Tickety (instancje) ---
  async createTicket(guildId, { channelId, userId, typeId, description }) {
    return await queryOne(`
      INSERT INTO tickets (guild_id, channel_id, user_id, type_id, description, status, opened_at)
      VALUES ($1, $2, $3, $4, $5, 'open', $6)
      RETURNING *
    `, [guildId, channelId, userId, typeId ?? null, description ?? null, Date.now()]);
  },

  async setTicketWelcomeMessageId(channelId, messageId) {
    await query('UPDATE tickets SET welcome_message_id = $1 WHERE channel_id = $2', [messageId, channelId]);
  },

  async incrementTicketMessageCount(channelId) {
    const row = await queryOne(`
      UPDATE tickets SET message_count = message_count + 1
      WHERE channel_id = $1
      RETURNING message_count
    `, [channelId]);
    return row ? row.message_count : 0;
  },

  async getTicketByChannel(channelId) {
    return await queryOne('SELECT * FROM tickets WHERE channel_id = $1', [channelId]);
  },

  async getOpenTicketsCountForUser(guildId, userId) {
    const row = await queryOne(`
      SELECT COUNT(*)::int as c FROM tickets
      WHERE guild_id = $1 AND user_id = $2 AND status = 'open'
    `, [guildId, userId]);
    return row ? row.c : 0;
  },

  async getOpenTicketsForUser(guildId, userId) {
    return await queryMany(`
      SELECT * FROM tickets WHERE guild_id = $1 AND user_id = $2 AND status = 'open'
    `, [guildId, userId]);
  },

  async closeTicket(channelId, { closedBy }) {
    await query(`
      UPDATE tickets
      SET status = 'closed', closed_at = $1, closed_by = $2
      WHERE channel_id = $3
    `, [Date.now(), closedBy ?? null, channelId]);
  },
};
