/**
 * sm2.js — SM-2 spaced repetition scheduling logic.
 *
 * Pure functions, no I/O. Card shape expected:
 *   { ease_factor, interval, repetitions }
 *
 * Ratings: 1 = Again, 2 = Hard, 3 = Good, 4 = Easy
 */

// Minimum ease factor — a card never gets harder than this.
const MIN_EASE = 1.3;
// Starting ease for brand-new cards.
const START_EASE = 2.5;
// Interval (days) granted when a brand-new card is rated Easy.
// (Standard Anki "easy graduation" behavior; raw SM-2 would give 0.)
const NEW_EASY_INTERVAL = 4;

/**
 * Apply a rating to a card and return the new scheduling values.
 * Does not mutate the input.
 */
function applyRating(card, rating) {
  if (![1, 2, 3, 4].includes(rating)) {
    throw new Error(`Invalid rating ${rating}; expected 1-4`);
  }

  let ease = card.ease_factor ?? START_EASE;
  let interval = card.interval ?? 0;
  let repetitions = card.repetitions ?? 0;

  switch (rating) {
    case 1: // Again — failed; back to the start of the queue
      repetitions = 0;
      interval = 0; // due again immediately (this session)
      ease = Math.max(MIN_EASE, ease - 0.2);
      break;

    case 2: // Hard — small step forward, slightly harder card
      interval = Math.max(1, Math.round(interval * 1.2));
      ease = Math.max(MIN_EASE, ease - 0.15);
      repetitions += 1;
      break;

    case 3: // Good — standard progression
      if (repetitions === 0) {
        interval = 1;
      } else if (repetitions === 1) {
        interval = 6;
      } else {
        interval = Math.round(interval * ease);
      }
      repetitions += 1;
      break;

    case 4: // Easy — big jump forward, card gets easier
      interval = Math.round(interval * ease * 1.3);
      if (interval <= 0) interval = NEW_EASY_INTERVAL;
      ease = ease + 0.15;
      repetitions += 1;
      break;
  }

  return { ease_factor: ease, interval, repetitions };
}

/**
 * Format an interval (in days) for display on a rating button.
 * 0 -> "<1m", 1 -> "1d", 30 -> "1mo", etc.
 */
function formatInterval(days) {
  if (days <= 0) return "<1m";
  if (days === 1) return "1d";
  if (days < 30) return `${days}d`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo`;
  const years = Math.floor(months / 12);
  const remMonths = months % 12;
  return remMonths ? `${years}y ${remMonths}mo` : `${years}y`;
}

/**
 * Preview what each rating button would do to this card.
 * Returns { again, hard, good, easy } as display strings.
 */
function previewIntervals(card) {
  return {
    again: formatInterval(applyRating(card, 1).interval),
    hard: formatInterval(applyRating(card, 2).interval),
    good: formatInterval(applyRating(card, 3).interval),
    easy: formatInterval(applyRating(card, 4).interval),
  };
}

/**
 * Compute the due date string (YYYY-MM-DD) for a card with the given interval.
 * interval 0 => due today (immediately).
 */
function dueDateFor(interval, fromDate = new Date()) {
  const d = new Date(fromDate);
  d.setDate(d.getDate() + interval);
  return d.toISOString().slice(0, 10);
}

/** Today's date as YYYY-MM-DD (local time). */
function todayStr() {
  // Use local date, not UTC, so "due today" matches the user's timezone.
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

module.exports = {
  MIN_EASE,
  START_EASE,
  applyRating,
  formatInterval,
  previewIntervals,
  dueDateFor,
  todayStr,
};
