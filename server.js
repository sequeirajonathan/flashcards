/**
 * server.js — Flashcards API + static frontend.
 *
 * Run:  npm install && npm start
 * Env:  PORT (default 3002), HOST (default 127.0.0.1), DB_PATH (default ./data/flashcards.db)
 *
 * On startup, cards are imported from ./cards/*.json (idempotent).
 * POST /api/cards/import-files re-runs the import without a restart.
 */
const path = require("path");
const express = require("express");
const db = require("./db");
const { importFromFiles } = require("./import-cards");
const { applyRating, previewIntervals, dueDateFor } = require("./sm2");

const app = express();
const PORT = process.env.PORT || 3002;
const HOST = process.env.HOST || "127.0.0.1";

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Helper: map thrown {status} errors to HTTP responses.
function handle(res, fn) {
  try {
    const result = fn();
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Internal error" });
  }
}

// ---------------------------------------------------------------------------
// Decks
// ---------------------------------------------------------------------------

app.get("/api/decks", (req, res) => handle(res, () => db.listDecks()));

app.post("/api/decks", (req, res) =>
  handle(res, () => {
    const deck = db.createDeck(req.body.name);
    res.status(201);
    return deck;
  })
);

app.delete("/api/decks/:id", (req, res) =>
  handle(res, () => {
    if (!db.deleteDeck(req.params.id)) {
      throw Object.assign(new Error("Deck not found"), { status: 404 });
    }
    return { deleted: true };
  })
);

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

app.get("/api/decks/:id/cards", (req, res) =>
  handle(res, () => db.listCards(req.params.id, { q: req.query.q, tag: req.query.tag }))
);

app.post("/api/decks/:id/cards", (req, res) =>
  handle(res, () => {
    const card = db.createCard(req.params.id, req.body);
    res.status(201);
    return card;
  })
);

// Bulk add — the endpoint an AI assistant uses to push cards.
app.post("/api/cards/batch", (req, res) =>
  handle(res, () => {
    const added = db.createCardsBatch(req.body.deck_id, req.body.cards);
    res.status(201);
    return { added };
  })
);

app.put("/api/cards/:id", (req, res) => handle(res, () => db.updateCard(req.params.id, req.body)));

app.delete("/api/cards/:id", (req, res) =>
  handle(res, () => {
    if (!db.deleteCard(req.params.id)) {
      throw Object.assign(new Error("Card not found"), { status: 404 });
    }
    return { deleted: true };
  })
);

// ---------------------------------------------------------------------------
// Review (SM-2)
// ---------------------------------------------------------------------------

app.get("/api/decks/:id/review", (req, res) =>
  handle(res, () => {
    const next = db.nextReviewCard(req.params.id, {
      newLimit: req.query.new_limit !== undefined ? Number(req.query.new_limit) : undefined,
      reviewLimit: req.query.review_limit !== undefined ? Number(req.query.review_limit) : undefined,
    });
    if (!next) return { done: true };
    const { card, queue, remaining } = next;
    return {
      id: card.id,
      deck_id: card.deck_id,
      front: card.front,
      back: card.back,
      tags: card.tags,
      queue, // "review" | "new"
      remaining,
      intervals: previewIntervals(card), // { again, hard, good, easy } display strings
    };
  })
);

app.post("/api/cards/:id/review", (req, res) =>
  handle(res, () => {
    const rating = Number(req.body.rating);
    const card = db.getCard(req.params.id);
    if (!card) throw Object.assign(new Error("Card not found"), { status: 404 });

    const scheduling = applyRating(card, rating);
    const due_date = dueDateFor(scheduling.interval);
    const updated = db.recordReview(card.id, rating, { ...scheduling, due_date });

    return {
      id: updated.id,
      rating,
      ease_factor: Math.round(updated.ease_factor * 100) / 100,
      interval: updated.interval,
      repetitions: updated.repetitions,
      due_date: updated.due_date,
      intervals: previewIntervals(updated),
    };
  })
);

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

app.post("/api/decks/:id/import", (req, res) =>
  handle(res, () => {
    const imported = db.importIntoDeck(req.params.id, {
      format: req.body.format,
      data: req.body.data,
    });
    res.status(201);
    return { imported };
  })
);

// Re-import cards from ./cards/*.json (e.g. after `git pull`).
// Idempotent — already-imported cards are skipped.
app.post("/api/cards/import-files", (req, res) =>
  handle(res, () => {
    const result = importFromFiles(db.raw());
    return result;
  })
);

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

app.get("/api/stats", (req, res) => handle(res, () => db.globalStats()));
app.get("/api/decks/:id/stats", (req, res) => handle(res, () => db.deckStats(req.params.id)));

// Health check (useful for systemd/pm2 monitoring)
app.get("/api/health", (req, res) => res.json({ ok: true }));

// Import cards from ./cards/*.json on startup (idempotent).
const startupImport = importFromFiles(db.raw());
if (startupImport.imported > 0 || startupImport.errors.length > 0) {
  console.log(
    `Card files: ${startupImport.imported} imported, ${startupImport.skipped} skipped` +
      (startupImport.errors.length ? `, errors: ${startupImport.errors.join("; ")}` : "")
  );
}

app.listen(PORT, HOST, () => {
  console.log(`Flashcards running on http://${HOST}:${PORT}`);
  console.log(`DB: ${process.env.DB_PATH || path.join(__dirname, "data", "flashcards.db")}`);
});
