(function installRating() {
  // Elo ratings for the ranked lobby. Pure numbers: no storage, no transport.
  const START_RATING = 1200;
  const RATING_MIN = 800;
  const RATING_MAX = 3000;
  const PROVISIONAL_GAMES = 10;
  const K_PROVISIONAL = 40;
  const K_ESTABLISHED = 24;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  // Probability that `rating` scores against `opponentRating`.
  function expectedScore(rating, opponentRating) {
    return 1 / (1 + 10 ** ((opponentRating - rating) / 400));
  }

  function kFactor(gamesPlayed) {
    return gamesPlayed < PROVISIONAL_GAMES ? K_PROVISIONAL : K_ESTABLISHED;
  }

  // score: 1 win, 0.5 draw, 0 loss. Both players' deltas use their pre-game ratings.
  function ratingDelta(rating, gamesPlayed, opponentRating, score) {
    const k = kFactor(gamesPlayed);
    const raw = Math.round(k * (score - expectedScore(rating, opponentRating)));
    return clamp(raw, -k, k);
  }

  // Mutates the player record and returns what changed.
  function applyResult(record, opponentRating, score) {
    const before = clamp(Math.round(Number(record.rating) || START_RATING), RATING_MIN, RATING_MAX);
    const gamesBefore = Math.max(0, Number(record.games) || 0);
    const delta = ratingDelta(before, gamesBefore, opponentRating, score);
    record.rating = clamp(before + delta, RATING_MIN, RATING_MAX);
    record.games = gamesBefore + 1;
    if (score === 1) record.wins = (Number(record.wins) || 0) + 1;
    else if (score === 0) record.losses = (Number(record.losses) || 0) + 1;
    else record.draws = (Number(record.draws) || 0) + 1;
    return { before, after: record.rating, delta: record.rating - before };
  }

  const ratingExports = {
    START_RATING,
    RATING_MIN,
    RATING_MAX,
    PROVISIONAL_GAMES,
    expectedScore,
    kFactor,
    ratingDelta,
    applyResult,
    clamp,
  };

  globalThis.BlendChessRating = ratingExports;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ratingExports;
  }
})();
