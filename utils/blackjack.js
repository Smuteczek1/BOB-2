const { randomInt } = require('node:crypto');

// ============================================================
//  BLACKJACK: sama logika gry (bez Discorda i bazy), żeby dało się ją testować.
//
//  ZASADY (jak w typowym kasynie, uproszczone):
//   - 6 talii, tasowane przed każdym rozdaniem (kryptograficzny RNG)
//   - krupier dobiera do 16 i staje na każdym 17 (także miękkim)
//   - blackjack (As + 10/figura na start) płaci 3:2 (x2.5), remis zwraca stawkę
//   - krupier zagląda pod kartę przy As/10: jeśli ma blackjacka, rozdanie kończy się od razu
//   - podwojenie (Double) na dowolnych dwóch kartach: jedna karta i koniec, stawka x2
//   - bez dzielenia par, ubezpieczenia i poddania
//   Wszystkie liczby zmienisz tutaj.
// ============================================================

const DECKS = 6;
const BLACKJACK_PAYOUT = 2.5; // wypłata łączna (stawka + wygrana 3:2)
const DEALER_STANDS_ON = 17;

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function newShoe() {
  const shoe = [];
  for (let d = 0; d < DECKS; d++) for (const suit of SUITS) for (const rank of RANKS) shoe.push({ rank, suit });
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
  }
  return shoe;
}

const cardPoints = (card) => (card.rank === 'A' ? 11 : ['J', 'Q', 'K'].includes(card.rank) ? 10 : Number(card.rank));

// { total, soft }: soft = As liczony jako 11
function handValue(cards) {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    total += cardPoints(c);
    if (c.rank === 'A') aces++;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return { total, soft: aces > 0 };
}

const isBlackjack = (cards) => cards.length === 2 && handValue(cards).total === 21;
const isBust = (cards) => handValue(cards).total > 21;

// ---------------- ROZDANIE ----------------
// outcome: null (gra trwa) | 'blackjack' | 'win' | 'push' | 'lose' | 'bust' | 'dealer_blackjack'
function startHand(shoe = newShoe()) {
  const game = {
    shoe,
    player: [shoe.pop(), shoe.pop()],
    dealer: [shoe.pop(), shoe.pop()], // dealer[0] = odkryta, dealer[1] = zakryta
    doubled: false,
    outcome: null,
  };

  const upcard = cardPoints(game.dealer[0]);
  const playerBj = isBlackjack(game.player);
  // Krupier zagląda pod kartę tylko przy As lub 10: wtedy blackjack krupiera kończy rozdanie od razu
  const dealerBj = (upcard === 10 || upcard === 11) && isBlackjack(game.dealer);

  if (dealerBj) game.outcome = playerBj ? 'push' : 'dealer_blackjack';
  else if (playerBj) game.outcome = 'blackjack';
  return game;
}

const canDouble = (game) => game.outcome === null && game.player.length === 2 && !game.doubled;

function dealerPlay(game) {
  while (handValue(game.dealer).total < DEALER_STANDS_ON) game.dealer.push(game.shoe.pop());
}

function resolve(game) {
  const p = handValue(game.player).total;
  const d = handValue(game.dealer).total;
  if (p > 21) game.outcome = 'bust';
  else if (d > 21 || p > d) game.outcome = 'win';
  else if (p === d) game.outcome = 'push';
  else game.outcome = 'lose';
}

function hit(game) {
  if (game.outcome !== null) throw new Error('blackjack: rozdanie już zakończone');
  game.player.push(game.shoe.pop());
  const { total } = handValue(game.player);
  if (total > 21) game.outcome = 'bust';
  else if (total === 21) stand(game); // 21 = automatyczne pasowanie
  return game;
}

function stand(game) {
  if (game.outcome !== null) throw new Error('blackjack: rozdanie już zakończone');
  dealerPlay(game);
  resolve(game);
  return game;
}

function double(game) {
  if (!canDouble(game)) throw new Error('blackjack: nie można podwoić');
  game.doubled = true;
  game.player.push(game.shoe.pop());
  if (isBust(game.player)) game.outcome = 'bust';
  else stand(game);
  return game;
}

// ---------------- WYPŁATA ----------------
// Stawka faktycznie postawiona (po podwojeniu x2) i łączna wypłata (stawka wraca w ramach wypłaty)
const stakeFor = (bet, game) => (game.doubled ? bet * 2 : bet);

function payoutFor(bet, game) {
  const stake = stakeFor(bet, game);
  switch (game.outcome) {
    case 'blackjack': return Math.floor(stake * BLACKJACK_PAYOUT);
    case 'win': return stake * 2;
    case 'push': return stake;
    default: return 0; // lose, bust, dealer_blackjack
  }
}

// ---------------- STRATEGIA PODSTAWOWA (do liczenia zwrotu RTP) ----------------
// Bez dzielenia par: pary traktujemy jak zwykłe sumy.
function basicStrategy(player, dealerUp) {
  const { total, soft } = handValue(player);
  const up = cardPoints(dealerUp); // As = 11
  const two = player.length === 2;
  const dbl = (cond) => (two && cond ? 'double' : 'hit');

  if (soft) {
    if (total >= 19) return 'stand';
    if (total === 18) {
      if (up >= 3 && up <= 6) return two ? 'double' : 'stand';
      return up === 2 || up === 7 || up === 8 ? 'stand' : 'hit';
    }
    if (total === 17) return dbl(up >= 3 && up <= 6);
    if (total === 15 || total === 16) return dbl(up >= 4 && up <= 6);
    return dbl(up >= 5 && up <= 6); // 13, 14
  }
  if (total >= 17) return 'stand';
  if (total >= 13) return up >= 2 && up <= 6 ? 'stand' : 'hit';
  if (total === 12) return up >= 4 && up <= 6 ? 'stand' : 'hit';
  if (total === 11) return dbl(true);
  if (total === 10) return dbl(up <= 9);
  if (total === 9) return dbl(up >= 3 && up <= 6);
  return 'hit';
}

// Symulacja: średnia wypłata na 1 monetę POSTAWIONEJ stawki początkowej (podwojenie dokłada, ale nie liczy się do mianownika),
// czyli to samo, co pokazują inne gry jako "zwrot". Wynik < 1 = przewaga kasyna.
function simulateRtp(hands = 1_000_000) {
  let returned = 0;
  for (let i = 0; i < hands; i++) {
    const game = startHand();
    while (game.outcome === null) {
      const action = basicStrategy(game.player, game.dealer[0]);
      if (action === 'double' && canDouble(game)) double(game);
      else if (action === 'stand') stand(game);
      else hit(game);
    }
    // stawka 100, żeby wypłata 3:2 nie była zaokrąglana; dopłata do podwojenia pomniejsza zysk
    returned += payoutFor(100, game) - (game.doubled ? 100 : 0);
  }
  return returned / (hands * 100);
}

module.exports = {
  DECKS,
  BLACKJACK_PAYOUT,
  DEALER_STANDS_ON,
  newShoe,
  cardPoints,
  handValue,
  isBlackjack,
  isBust,
  startHand,
  canDouble,
  hit,
  stand,
  double,
  stakeFor,
  payoutFor,
  basicStrategy,
  simulateRtp,
};
