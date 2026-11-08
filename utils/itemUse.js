const db = require('../db');
const items = require('./items');
const inv = require('./inventory');
const lotto = require('./lotto');
const work = require('./work');
const { formatCoins } = require('./economy');

const { Refused } = inv;

const ok = (title, lines, color = 0xd4af37) => ({ ok: true, title, lines, color });
const refuse = (message) => ({ ok: false, message });

// Bonus przedmiotu: uruchamia się raz i nie wywołuje kolejnych bonusów. Zwraca tekst do pokazania albo null.
async function applyGrantBonus(c, guildId, userId, def) {
  const b = def.bonus;
  if (!b || !b.grant || b.onlyIfRefund) return null;
  if (!items.chance(b.chance)) return null;
  const added = await inv.addItem(c, guildId, userId, b.grant, 1);
  if (!added) return null;
  const g = items.ITEMS[b.grant];
  return `🎁 **Bonus!** Dostajesz: ${g.emoji} **${g.name}**`;
}

// ---------------- UŻYCIE ----------------
// Zwraca { ok: true, title, lines, color } albo { ok: false, message }.
// Skrzyń NIE otwiera (to robi gra w commands/ekwipunek.js), bo wymaga wyboru przez gracza.
async function useItem(guildId, userId, itemId) {
  const def = items.ITEMS[itemId];
  if (!def) return refuse('Nie znam takiego przedmiotu.');

  try {
    switch (def.use.type) {
      case 'money': return await useMoney(guildId, userId, def);
      case 'ticket': return await useTicket(guildId, userId, def);
      case 'arm_luck': return await useArmLuck(guildId, userId, def);
      case 'arm_daily': return await useArmDaily(guildId, userId, def);
      case 'budzik': return await useBudzik(guildId, userId, def);
      case 'polisa': return await usePolisa(guildId, userId, def);
      case 'work_energy':
      case 'work_reset':
      case 'work_boost': return await useWork(guildId, userId, def);
      case 'none': return refuse(def.use.message ?? 'Tego przedmiotu nie da się użyć.');
      default: return refuse('Tego przedmiotu nie da się jeszcze użyć.');
    }
  } catch (err) {
    if (err instanceof Refused) return refuse(err.message);
    throw err;
  }
}

async function requireItem(c, guildId, userId, itemId) {
  if (!(await inv.removeItem(c, guildId, userId, itemId, 1))) throw new Refused('Nie masz już tego przedmiotu.');
}

// ---- Przedmioty do pracy: Kawa, Przekąska, Energetyk, Mega energetyk, Karta przerwy, Premia, Szkolenie ----
async function useWork(guildId, userId, def) {
  await work.ensureSchema();
  return db.withTransaction(async (c) => {
    await requireItem(c, guildId, userId, def.id);
    const r = await work.applyItemEffect(c, guildId, userId, def.use);
    if (!r.ok) throw new Refused(r.message); // wyjątek cofa transakcję: przedmiot nie przepada
    return ok(`${def.emoji} ${def.name}`, r.lines, 0xe67e22);
  });
}

// ---- Teczka, Aktówka, Walizka, Sejf, Skarbiec, Kufer, Czarna Skrzynka ----
async function useMoney(guildId, userId, def) {
  // Jednorazowa Koniczynka działa tylko na skrzynie (zużywa się przy ich otwarciu), więc tu liczy się samo szczęście stałe
  const lb = await inv.getLuckBreakdown(guildId, userId);
  const luck = Math.min(items.LUCK_CAP, lb.raw - lb.once);
  return db.withTransaction(async (c) => {
    await requireItem(c, guildId, userId, def.id);

    const row = await c.query('SELECT balance FROM economy_accounts WHERE guild_id = $1 AND user_id = $2 FOR UPDATE', [guildId, userId]);
    const balance = Number(row.rows[0]?.balance ?? 0);
    const outcome = items.rollMoney(def.use, balance, luck);

    const lines = [];
    let color = 0x95a5a6;
    let newBalance = balance;

    if (outcome.kind === 'gain') {
      newBalance = await db.applyCredit(c, guildId, userId, outcome.amount, `item_${def.id}`, true);
      lines.push(`Znalazłeś/aś: ${formatCoins(outcome.amount)}!`);
      color = 0x2ecc71;
    } else if (outcome.kind === 'fine' && outcome.amount > 0) {
      const res = await c.query(`
        UPDATE economy_accounts SET balance = balance - $3::bigint
        WHERE guild_id = $1 AND user_id = $2 AND balance >= $3::bigint RETURNING balance
      `, [guildId, userId, outcome.amount]);
      newBalance = Number(res.rows[0].balance);
      await c.query(`
        INSERT INTO economy_transactions (guild_id, user_id, amount, balance_after, reason, created_at)
        VALUES ($1, $2, $3::bigint, $4::bigint, 'mandat', $5::bigint)
      `, [guildId, userId, -outcome.amount, newBalance, Date.now()]);
      lines.push(`🚓 **Mandat!** Tracisz ${formatCoins(outcome.amount)}.`);
      color = 0xe74c3c;
    } else if (outcome.kind === 'fine') {
      lines.push('🚓 Trafił się mandat, ale nie masz z czego go zapłacić. Szczęściarz!');
    } else {
      lines.push('W środku pusto. Tylko stare papiery i zapach whisky...');
    }

    const bonus = await applyGrantBonus(c, guildId, userId, def);
    if (bonus) lines.push(bonus);
    lines.push(`Saldo: ${formatCoins(newBalance)}`);
    return ok(`${def.emoji} ${def.name}`, lines, color);
  });
}

// ---- Darmowy los, Pakiet losów ----
async function useTicket(guildId, userId, def) {
  await lotto.ensureSchema();
  return db.withTransaction(async (c) => {
    await requireItem(c, guildId, userId, def.id);

    const extra = def.bonus?.extraTickets && items.chance(def.bonus.chance) ? def.bonus.extraTickets : 0;
    const res = await lotto.grantFreeTicketsTx(c, guildId, userId, def.use.count + extra);
    if (res.granted === 0) throw new Refused(`Masz już maksymalną liczbę losów na to losowanie (${lotto.MAX_TICKETS}). Przedmiot nie został zużyty.`);

    const lines = [`Dostajesz **${res.granted}** ${res.granted === 1 ? 'los' : 'losy'} loterii (losowe liczby):`];
    for (const t of res.tickets) lines.push(`• ${t.numbers.join(', ')}`);

    if (res.leftover > 0 && def.use.overflowToItems) {
      await inv.addItem(c, guildId, userId, 'darmowy_los', res.leftover);
      lines.push(`📦 Limit losów osiągnięty: ${res.leftover} wróciło do ekwipunku jako **Darmowy los**.`);
    }
    if (extra > 0 && res.granted > def.use.count) lines.push('🎁 **Bonus!** Dodatkowy los gratis!');

    const bonus = await applyGrantBonus(c, guildId, userId, def);
    if (bonus) lines.push(bonus);
    return ok(`${def.emoji} ${def.name}`, lines, 0x3498db);
  });
}

// ---- Koniczynka: bonus szczęścia na NASTĘPNĄ skrzynię (dzienną albo ze sklepu) ----
// Zużywa się przy otwarciu skrzyni (w tej samej transakcji, patrz inventory.settleChestOpen / claimDailyBundle).
// Koniczyna i Podkowa (stałe) nie wymagają użycia, działają same.
async function useArmLuck(guildId, userId, def) {
  return db.withTransaction(async (c) => {
    const armed = await c.query(`
      INSERT INTO user_armed (guild_id, user_id, kind, item_id, armed_at) VALUES ($1, $2, 'luck_once', $3, $4::bigint)
      ON CONFLICT (guild_id, user_id, kind) DO NOTHING RETURNING item_id
    `, [guildId, userId, def.id, Date.now()]);
    if (armed.rowCount === 0) throw new Refused('Masz już włączoną Koniczynkę. Zadziała przy następnej skrzyni. Przedmiot nie został zużyty.');

    await requireItem(c, guildId, userId, def.id);
    return ok(`${def.emoji} ${def.name} gotowa`, [
      `+${def.use.bonus}% szczęścia przy **następnej skrzyni** (dziennej albo ze sklepu). Sumuje się ze stałym szczęściem.`,
      'Nie działa w kasynie ani loterii.',
    ], 0x2ecc71);
  });
}

// ---- Latarka i Zapasowy klucz: modyfikator NASTĘPNEJ dziennej skrzyni ----
async function useArmDaily(guildId, userId, def) {
  return db.withTransaction(async (c) => {
    const armed = await c.query(`
      INSERT INTO user_armed (guild_id, user_id, kind, item_id, armed_at) VALUES ($1, $2, 'daily_mod', $3, $4::bigint)
      ON CONFLICT (guild_id, user_id, kind) DO NOTHING RETURNING item_id
    `, [guildId, userId, def.id, Date.now()]);
    if (armed.rowCount === 0) throw new Refused('Masz już włączony modyfikator dziennej skrzyni (Latarka albo Zapasowy klucz). Jeden na odbiór. Przedmiot nie został zużyty.');

    await requireItem(c, guildId, userId, def.id);
    const lines = [`Zadziała przy **następnym** \`/nagroda\`. ${def.desc}`];
    const bonus = await applyGrantBonus(c, guildId, userId, def);
    if (bonus) lines.push(bonus);
    return ok(`${def.emoji} ${def.name} gotowa`, lines, 0x3498db);
  });
}

// ---- Budzik Boba: drugie odebranie dziennej skrzyni ----
async function useBudzik(guildId, userId, def) {
  if (await db.canClaimDaily(guildId, userId)) {
    throw new Refused('Najpierw odbierz dzisiejszą skrzynię (`/nagroda`). Budzik odnawia skrzynię, którą już odebrałeś/aś. Przedmiot nie został zużyty.');
  }
  return db.withTransaction(async (c) => {
    await requireItem(c, guildId, userId, def.id);
    await c.query('UPDATE user_levels SET last_daily_at = NULL WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
    await c.query(`
      INSERT INTO user_armed (guild_id, user_id, kind, item_id, armed_at) VALUES ($1, $2, 'daily_item', $3, $4::bigint)
      ON CONFLICT (guild_id, user_id, kind) DO UPDATE SET item_id = EXCLUDED.item_id, armed_at = EXCLUDED.armed_at
    `, [guildId, userId, def.id, Date.now()]);
    return ok(`${def.emoji} Budzik zadzwonił!`, ['Możesz odebrać dzienną skrzynię jeszcze raz: wpisz `/nagroda`.', `W tym odbiorze szansa na przedmiot to ${Math.round(items.DAILY_ITEM_CHANCE_BUDZIK * 100)}% zamiast ${Math.round(items.DAILY_ITEM_CHANCE * 100)}%.`], 0xf1c40f);
  });
}

// ---- Polisy: włączone przed grą w kasynie, zużywają się przy NASTĘPNEJ grze ----
async function usePolisa(guildId, userId, def) {
  return db.withTransaction(async (c) => {
    const armed = await c.query(`
      INSERT INTO user_armed (guild_id, user_id, kind, item_id, armed_at) VALUES ($1, $2, 'polisa', $3, $4::bigint)
      ON CONFLICT (guild_id, user_id, kind) DO NOTHING RETURNING item_id
    `, [guildId, userId, def.id, Date.now()]);
    if (armed.rowCount === 0) throw new Refused('Masz już włączoną polisę. Jedna na grę. Przedmiot nie został zużyty.');

    await requireItem(c, guildId, userId, def.id);
    return ok(`${def.emoji} ${def.name} włączona`, [
      `Zadziała w Twojej **następnej grze w kasynie**: po przegranej ${def.use.chance}% szans na zwrot straty (maksymalnie ${formatCoins(def.use.cap)}).`,
      'Polisa zużywa się przy tej grze niezależnie od wyniku.',
    ], 0x3498db);
  });
}

module.exports = { useItem };
