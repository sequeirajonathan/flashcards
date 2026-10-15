/**
 * import-cards.js — Import flashcards from JSON files in ./cards/.
 *
 * This is how new cards get into the app without UI access:
 * an assistant (or anyone) commits a JSON file to cards/, and the app
 * picks it up on startup (or via POST /api/cards/import-files).
 *
 * File format:
 *   { "deck": "Deck Name",
 *     "cards": [ { "front": "...", "back": "...", "tags": "a,b" }, ... ] }
 *
 * Import is idempotent: a card is skipped if the same deck already has
 * a card with identical front text. Re-running never creates duplicates.
 */
const fs = require("fs");
const path = require("path");

const CARDS_DIR = path.join(__dirname, "cards");

function importFromFiles(db) {
  const result = { files: 0, imported: 0, skipped: 0, errors: [] };

  let files;
  try {
    files = fs.readdirSync(CARDS_DIR).filter((f) => f.endsWith(".json"));
  } catch (err) {
    if (err.code === "ENOENT") return result; // no cards/ dir yet — fine
    throw err;
  }

  const findDeck = db.prepare("SELECT id FROM decks WHERE name = ?");
  const insertDeck = db.prepare("INSERT INTO decks (name) VALUES (?)");
  const findCard = db.prepare(
    "SELECT id FROM cards WHERE deck_id = ? AND front = ?"
  );
  const insertCard = db.prepare(
    "INSERT INTO cards (deck_id, front, back, tags) VALUES (?, ?, ?, ?)"
  );

  const importMany = db.transaction((deckId, cards) => {
    let imported = 0;
    let skipped = 0;
    for (const c of cards) {
      if (!c.front || !c.back) {
        skipped++;
        continue;
      }
      if (findCard.get(deckId, c.front)) {
        skipped++;
        continue;
      }
      insertCard.run(deckId, c.front, c.back, c.tags || "");
      imported++;
    }
    return { imported, skipped };
  });

  for (const file of files) {
    const fullPath = path.join(CARDS_DIR, file);
    try {
      const data = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      if (!data.deck || !Array.isArray(data.cards)) {
        result.errors.push(`${file}: missing "deck" or "cards" array`);
        continue;
      }
      let deck = findDeck.get(data.deck);
      if (!deck) {
        const info = insertDeck.run(data.deck);
        deck = { id: info.lastInsertRowid };
      }
      const { imported, skipped } = importMany(deck.id, data.cards);
      result.files++;
      result.imported += imported;
      result.skipped += skipped;
    } catch (err) {
      result.errors.push(`${file}: ${err.message}`);
    }
  }

  return result;
}

module.exports = { importFromFiles, CARDS_DIR };
