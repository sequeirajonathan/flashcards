/**
 * db.js — SQLite schema + data-access helpers (better-sqlite3).
 *
 * Tables:
 *   decks   (id, name UNIQUE, created_at)
 *   cards   (id, deck_id FK CASCADE, front, back, tags,
 *            ease_factor, interval, repetitions, due_date, created_at, updated_at)
 *   reviews (id, card_id FK CASCADE, rating 1-4, reviewed_at)
 */
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const { START_EASE, todayStr } = require("./sm2");

const DB_DIR = process.env.DB_PATH
  ? path.dirname(process.env.DB_PATH)
  : path.join(__dirname, "data");
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const DB_PATH =
  process.env.DB_PATH || path.join(DB_DIR, "flashcards.db");

const db = new Database(DB_PATH);
// Enforce foreign keys so deleting a deck cascades to its cards/reviews.
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS decks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
    front TEXT NOT NULL,
    back TEXT NOT NULL,
    tags TEXT DEFAULT '',
    ease_factor REAL DEFAULT ${START_EASE},
    interval INTEGER DEFAULT 0,
    repetitions INTEGER DEFAULT 0,
    due_date TEXT DEFAULT (date('now', 'localtime')),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 4),
    reviewed_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_cards_deck ON cards(deck_id);
  CREATE INDEX IF NOT EXISTS idx_cards_due ON cards(deck_id, due_date);
  CREATE INDEX IF NOT EXISTS idx_reviews_card ON reviews(card_id);
  CREATE INDEX IF NOT EXISTS idx_reviews_at ON reviews(reviewed_at);
`);

// ---------------------------------------------------------------------------
// Decks
// ---------------------------------------------------------------------------

function listDecks() {
  const today = todayStr();
  return db
    .prepare(
      `SELECT d.id, d.name,
         (SELECT COUNT(*) FROM cards c
            WHERE c.deck_id = d.id
              AND c.due_date <= ?
              AND EXISTS (SELECT 1 FROM reviews r WHERE r.card_id = c.id)
         ) AS due_count,
         (SELECT COUNT(*) FROM cards c
            WHERE c.deck_id = d.id
              AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.card_id = c.id)
         ) AS new_count,
         (SELECT COUNT(*) FROM cards c WHERE c.deck_id = d.id) AS total_count
       FROM decks d ORDER BY d.name`
    )
    .all(today);
}

function getDeck(id) {
  return db.prepare("SELECT id, name FROM decks WHERE id = ?").get(id);
}

function createDeck(name) {
  const clean = String(name || "").trim();
  if (!clean) throw Object.assign(new Error("Deck name is required"), { status: 400 });
  try {
    const info = db.prepare("INSERT INTO decks (name) VALUES (?)").run(clean);
    return getDeck(info.lastInsertRowid);
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      throw Object.assign(new Error(`Deck "${clean}" already exists`), { status: 409 });
    }
    throw err;
  }
}

function deleteDeck(id) {
  const info = db.prepare("DELETE FROM decks WHERE id = ?").run(id);
  return info.changes > 0;
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

const CARD_COLS =
  "id, deck_id, front, back, tags, ease_factor, interval, repetitions, due_date, created_at, updated_at";

function getCard(id) {
  return db.prepare(`SELECT ${CARD_COLS} FROM cards WHERE id = ?`).get(id);
}

function listCards(deckId, { q = "", tag = "" } = {}) {
  let sql = `SELECT ${CARD_COLS} FROM cards WHERE deck_id = ?`;
  const params = [deckId];
  if (q) {
    sql += " AND (front LIKE ? OR back LIKE ?)";
    params.push(`%${q}%`, `%${q}%`);
  }
  if (tag) {
    // Tags are comma-separated; match whole tokens loosely.
    sql += " AND (',' || tags || ',' LIKE ?)";
    params.push(`%,${tag.trim()},%`);
  }
  sql += " ORDER BY created_at DESC, id DESC";
  return db.prepare(sql).all(...params);
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) tags = tags.join(",");
  return String(tags || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .join(",");
}

function createCard(deckId, { front, back, tags }) {
  if (!getDeck(deckId)) throw Object.assign(new Error("Deck not found"), { status: 404 });
  if (!String(front || "").trim() || !String(back || "").trim()) {
    throw Object.assign(new Error("front and back are required"), { status: 400 });
  }
  const info = db
    .prepare(
      `INSERT INTO cards (deck_id, front, back, tags, due_date)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(deckId, String(front).trim(), String(back).trim(), normalizeTags(tags), todayStr());
  return getCard(info.lastInsertRowid);
}

function createCardsBatch(deckId, cards) {
  if (!getDeck(deckId)) throw Object.assign(new Error("Deck not found"), { status: 404 });
  if (!Array.isArray(cards)) throw Object.assign(new Error("cards must be an array"), { status: 400 });
  const insert = db.prepare(
    `INSERT INTO cards (deck_id, front, back, tags, due_date) VALUES (?, ?, ?, ?, ?)`
  );
  const today = todayStr();
  let added = 0;
  const txn = db.transaction((list) => {
    for (const c of list) {
      if (!c || !String(c.front || "").trim() || !String(c.back || "").trim()) continue;
      insert.run(deckId, String(c.front).trim(), String(c.back).trim(), normalizeTags(c.tags), today);
      added++;
    }
  });
  txn(cards);
  return added;
}

function updateCard(id, { front, back, tags }) {
  const card = getCard(id);
  if (!card) throw Object.assign(new Error("Card not found"), { status: 404 });
  const next = {
    front: front !== undefined ? String(front).trim() : card.front,
    back: back !== undefined ? String(back).trim() : card.back,
    tags: tags !== undefined ? normalizeTags(tags) : card.tags,
  };
  if (!next.front || !next.back) {
    throw Object.assign(new Error("front and back cannot be empty"), { status: 400 });
  }
  db.prepare(
    `UPDATE cards SET front = ?, back = ?, tags = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(next.front, next.back, next.tags, id);
  return getCard(id);
}

function deleteCard(id) {
  return db.prepare("DELETE FROM cards WHERE id = ?").run(id).changes > 0;
}

// ---------------------------------------------------------------------------
// Review queue
// ---------------------------------------------------------------------------

const DEFAULT_NEW_LIMIT = 20;
const DEFAULT_REVIEW_LIMIT = 100;

/**
 * Next card for a study session: due (previously reviewed) cards first,
 * oldest due first; then new (never reviewed) cards.
 * Respects per-session new/review limits.
 */
function nextReviewCard(deckId, { newLimit = DEFAULT_NEW_LIMIT, reviewLimit = DEFAULT_REVIEW_LIMIT } = {}) {
  if (!getDeck(deckId)) throw Object.assign(new Error("Deck not found"), { status: 404 });
  const today = todayStr();

  const due = db
    .prepare(
      `SELECT ${CARD_COLS} FROM cards
       WHERE deck_id = ?
         AND due_date <= ?
         AND EXISTS (SELECT 1 FROM reviews r WHERE r.card_id = cards.id)
       ORDER BY due_date ASC, id ASC
       LIMIT ?`
    )
    .all(deckId, today, Math.max(0, reviewLimit));

  if (due.length > 0) return { card: due[0], queue: "review", remaining: due.length };

  const fresh = db
    .prepare(
      `SELECT ${CARD_COLS} FROM cards
       WHERE deck_id = ?
         AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.card_id = cards.id)
       ORDER BY created_at ASC, id ASC
       LIMIT ?`
    )
    .all(deckId, Math.max(0, newLimit));

  if (fresh.length > 0) return { card: fresh[0], queue: "new", remaining: fresh.length };

  return null;
}

function recordReview(cardId, rating, scheduling) {
  const txn = db.transaction(() => {
    db.prepare("INSERT INTO reviews (card_id, rating) VALUES (?, ?)").run(cardId, rating);
    db.prepare(
      `UPDATE cards
       SET ease_factor = ?, interval = ?, repetitions = ?, due_date = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      scheduling.ease_factor,
      scheduling.interval,
      scheduling.repetitions,
      scheduling.due_date,
      cardId
    );
  });
  txn();
  return getCard(cardId);
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function deckStats(deckId) {
  const deck = getDeck(deckId);
  if (!deck) throw Object.assign(new Error("Deck not found"), { status: 404 });
  const today = todayStr();

  const counts = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN due_date <= ? AND EXISTS (SELECT 1 FROM reviews r WHERE r.card_id = cards.id) THEN 1 ELSE 0 END) AS due,
         SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM reviews r WHERE r.card_id = cards.id) THEN 1 ELSE 0 END) AS new
       FROM cards WHERE deck_id = ?`
    )
    .get(today, deckId);

  const reviewedToday = db
    .prepare(
      `SELECT COUNT(*) AS n FROM reviews r
       JOIN cards c ON c.id = r.card_id
       WHERE c.deck_id = ? AND date(r.reviewed_at, 'localtime') = ?`
    )
    .get(deckId, today).n;

  const retentionRow = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN r.rating >= 3 THEN 1 ELSE 0 END) AS passed
       FROM reviews r
       JOIN cards c ON c.id = r.card_id
       WHERE c.deck_id = ? AND r.reviewed_at >= datetime('now', '-30 days')`
    )
    .get(deckId);

  const history = db
    .prepare(
      `SELECT date(r.reviewed_at, 'localtime') AS day, COUNT(*) AS reviews,
              SUM(CASE WHEN r.rating >= 3 THEN 1 ELSE 0 END) AS passed
       FROM reviews r
       JOIN cards c ON c.id = r.card_id
       WHERE c.deck_id = ? AND r.reviewed_at >= datetime('now', '-30 days')
       GROUP BY day ORDER BY day ASC`
    )
    .all(deckId);

  return {
    deck_id: deckId,
    name: deck.name,
    total_cards: counts.total,
    due_today: counts.due,
    new_today: counts.new,
    reviewed_today: reviewedToday,
    retention_30d:
      retentionRow.total > 0 ? Math.round((retentionRow.passed / retentionRow.total) * 1000) / 10 : null,
    history_30d: history,
  };
}

function globalStats() {
  const today = todayStr();
  const decks = listDecks();
  const totalCards = decks.reduce((s, d) => s + d.total_count, 0);
  const dueToday = decks.reduce((s, d) => s + d.due_count, 0);
  const newToday = decks.reduce((s, d) => s + d.new_count, 0);

  const reviewedToday = db
    .prepare(`SELECT COUNT(*) AS n FROM reviews WHERE date(reviewed_at, 'localtime') = ?`)
    .get(today).n;

  const retentionRow = db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN rating >= 3 THEN 1 ELSE 0 END) AS passed
       FROM reviews WHERE reviewed_at >= datetime('now', '-30 days')`
    )
    .get();

  const history = db
    .prepare(
      `SELECT date(reviewed_at, 'localtime') AS day, COUNT(*) AS reviews,
              SUM(CASE WHEN rating >= 3 THEN 1 ELSE 0 END) AS passed
       FROM reviews
       WHERE reviewed_at >= datetime('now', '-30 days')
       GROUP BY day ORDER BY day ASC`
    )
    .all();

  return {
    total_decks: decks.length,
    total_cards: totalCards,
    due_today: dueToday,
    new_today: newToday,
    reviewed_today: reviewedToday,
    retention_30d:
      retentionRow.total > 0 ? Math.round((retentionRow.passed / retentionRow.total) * 1000) / 10 : null,
    history_30d: history,
  };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

function parseTsv(data) {
  // Expected columns: front \t back \t tags (tags optional)
  return String(data || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [front = "", back = "", tags = ""] = line.split("\t");
      return { front: front.trim(), back: back.trim(), tags: tags.trim() };
    })
    .filter((c) => c.front && c.back);
}

function importIntoDeck(deckId, { format, data }) {
  let cards;
  if (format === "tsv") {
    cards = parseTsv(data);
  } else if (format === "json") {
    try {
      const parsed = JSON.parse(data);
      if (!Array.isArray(parsed)) throw new Error("JSON must be an array");
      cards = parsed
        .map((c) => ({
          front: String(c.front || "").trim(),
          back: String(c.back || "").trim(),
          tags: c.tags,
        }))
        .filter((c) => c.front && c.back);
    } catch (err) {
      throw Object.assign(new Error(`Invalid JSON: ${err.message}`), { status: 400 });
    }
  } else {
    throw Object.assign(new Error("format must be 'tsv' or 'json'"), { status: 400 });
  }
  return createCardsBatch(deckId, cards);
}

module.exports = {
  raw: () => db, // raw better-sqlite3 handle (used by import-cards.js)
  listDecks,
  getDeck,
  createDeck,
  deleteDeck,
  getCard,
  listCards,
  createCard,
  createCardsBatch,
  updateCard,
  deleteCard,
  nextReviewCard,
  recordReview,
  deckStats,
  globalStats,
  importIntoDeck,
  DEFAULT_NEW_LIMIT,
  DEFAULT_REVIEW_LIMIT,
};
