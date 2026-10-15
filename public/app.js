/* Flashcards SPA — vanilla JS, no build step. */
"use strict";

const $ = (sel) => document.querySelector(sel);
const api = {
  async get(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.json();
  },
  async send(url, method, body) {
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.json();
  },
  post: (url, body) => api.send(url, "POST", body),
  put: (url, body) => api.send(url, "PUT", body),
  del: (url) => api.send(url, "DELETE"),
};

const state = {
  view: "decks",
  decks: [],
  study: null, // { deckId, deckName, current, reviewed }
};

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function showView(name) {
  state.view = name;
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  $("#view-" + name).classList.remove("hidden");
  document.querySelectorAll(".nav-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === name)
  );
  // Study view hides the bottom nav for focus; restore otherwise.
  document.querySelector(".bottom-nav").style.display = name === "study" ? "none" : "flex";
  window.scrollTo(0, 0);
}

document.querySelectorAll(".nav-btn").forEach((b) =>
  b.addEventListener("click", () => {
    showView(b.dataset.view);
    if (b.dataset.view === "decks") renderDecks();
    if (b.dataset.view === "browse") renderBrowse();
    if (b.dataset.view === "add") renderAdd();
    if (b.dataset.view === "stats") renderStats();
  })
);

// ---------------------------------------------------------------------------
// Decks view
// ---------------------------------------------------------------------------

async function loadDecks() {
  state.decks = await api.get("/api/decks");
}

function badge(n, cls) {
  return `<span class="badge ${cls} ${n === 0 ? "zero" : ""}">${n}</span>`;
}

async function renderDecks() {
  await loadDecks();
  const list = $("#deck-list");
  if (state.decks.length === 0) {
    list.innerHTML = `<div class="empty">No decks yet.<br>Tap <b>+ New</b> to create one.</div>`;
    return;
  }
  list.innerHTML = state.decks
    .map(
      (d) => `
      <button class="deck-card" data-id="${d.id}" data-name="${escapeAttr(d.name)}">
        <span class="deck-name">${escapeHtml(d.name)}<small>${d.total_count} cards</small></span>
        ${badge(d.due_count, "badge-due")}
        ${badge(d.new_count, "badge-new")}
      </button>`
    )
    .join("");
  list.querySelectorAll(".deck-card").forEach((el) =>
    el.addEventListener("click", () => startStudy(Number(el.dataset.id), el.dataset.name))
  );
}

$("#btn-new-deck").addEventListener("click", async () => {
  const name = prompt("Deck name:");
  if (!name || !name.trim()) return;
  try {
    await api.post("/api/decks", { name: name.trim() });
    renderDecks();
  } catch (e) {
    alert("Could not create deck: " + e.message);
  }
});

// Re-import cards from the server's cards/*.json files (e.g. after git pull).
$("#btn-import-files").addEventListener("click", async () => {
  try {
    const r = await api.post("/api/cards/import-files", {});
    const msg =
      `Imported ${r.imported} new card(s)` +
      (r.skipped ? `, ${r.skipped} already present` : "") +
      (r.errors && r.errors.length ? `\nErrors:\n${r.errors.join("\n")}` : "");
    alert(msg);
    renderDecks();
    renderStats();
  } catch (e) {
    alert("Import failed: " + e.message);
  }
});

// ---------------------------------------------------------------------------
// Study view (SM-2 review session)
// ---------------------------------------------------------------------------

async function startStudy(deckId, deckName) {
  state.study = { deckId, deckName, current: null, reviewed: 0 };
  $("#study-deck-name").textContent = deckName;
  $("#study-done").classList.add("hidden");
  $("#study-card").classList.remove("hidden");
  showView("study");
  await nextStudyCard();
}

async function nextStudyCard() {
  const s = state.study;
  const data = await api.get(`/api/decks/${s.deckId}/review`);
  if (data.done) return finishStudy();

  s.current = data;
  $("#study-front").textContent = data.front;
  $("#study-back").textContent = data.back;
  $("#study-back").classList.add("hidden");
  $("#btn-show-answer").classList.remove("hidden");
  $("#study-ratings").classList.add("hidden");

  const total = data.remaining + s.reviewed;
  $("#study-progress").textContent = total > 0 ? `${data.remaining} left` : "";
}

$("#btn-show-answer").addEventListener("click", () => {
  const s = state.study;
  if (!s || !s.current) return;
  $("#study-back").classList.remove("hidden");
  $("#btn-show-answer").classList.add("hidden");
  const ratings = $("#study-ratings");
  ratings.classList.remove("hidden");
  const iv = s.current.intervals;
  ratings.querySelector('[data-rating="1"] .interval').textContent = iv.again;
  ratings.querySelector('[data-rating="2"] .interval').textContent = iv.hard;
  ratings.querySelector('[data-rating="3"] .interval').textContent = iv.good;
  ratings.querySelector('[data-rating="4"] .interval').textContent = iv.easy;
});

document.querySelectorAll(".btn-rate").forEach((btn) =>
  btn.addEventListener("click", async () => {
    const s = state.study;
    if (!s || !s.current) return;
    btn.disabled = true;
    try {
      await api.post(`/api/cards/${s.current.id}/review`, {
        rating: Number(btn.dataset.rating),
      });
      s.reviewed++;
    } catch (e) {
      alert("Could not record review: " + e.message);
    } finally {
      btn.disabled = false;
    }
    await nextStudyCard();
  })
);

function finishStudy() {
  const s = state.study;
  $("#study-card").classList.add("hidden");
  $("#study-done").classList.remove("hidden");
  $("#study-progress").textContent = "";
  $("#study-summary").textContent =
    s.reviewed === 0
      ? "Nothing was due. Come back tomorrow!"
      : `You reviewed ${s.reviewed} card${s.reviewed === 1 ? "" : "s"} in "${s.deckName}".`;
}

$("#study-exit").addEventListener("click", () => {
  showView("decks");
  renderDecks();
});
$("#btn-study-again").addEventListener("click", () => {
  showView("decks");
  renderDecks();
});

// ---------------------------------------------------------------------------
// Browse view
// ---------------------------------------------------------------------------

let browseDebounce = null;

async function renderBrowse() {
  await loadDecks();
  const sel = $("#browse-deck");
  sel.innerHTML = state.decks.map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join("");
  if (state.decks.length === 0) {
    $("#browse-list").innerHTML = `<div class="empty">No decks yet.</div>`;
    return;
  }
  await refreshBrowseList();
}

async function refreshBrowseList() {
  const deckId = $("#browse-deck").value;
  if (!deckId) return;
  const q = encodeURIComponent($("#browse-search").value.trim());
  const tag = encodeURIComponent($("#browse-tag").value.trim());
  const cards = await api.get(`/api/decks/${deckId}/cards?q=${q}&tag=${tag}`);
  const list = $("#browse-list");
  if (cards.length === 0) {
    list.innerHTML = `<div class="empty">No cards match.</div>`;
    return;
  }
  list.innerHTML = cards
    .map(
      (c) => `
      <div class="browse-card" data-id="${c.id}">
        <div class="front">${escapeHtml(c.front)}</div>
        <div class="back">${escapeHtml(c.back)}</div>
        ${c.tags ? `<div class="tags">${escapeHtml(c.tags)}</div>` : ""}
        <div class="browse-actions">
          <button class="btn btn-edit">Edit</button>
          <button class="btn btn-danger btn-delete">Delete</button>
        </div>
      </div>`
    )
    .join("");
  list.querySelectorAll(".browse-card").forEach((el) => {
    const id = Number(el.dataset.id);
    el.querySelector(".btn-edit").addEventListener("click", () => openEditModal(id));
    el.querySelector(".btn-delete").addEventListener("click", async () => {
      if (!confirm("Delete this card?")) return;
      await api.del(`/api/cards/${id}`);
      refreshBrowseList();
    });
  });
}

["browse-deck"].forEach((id) => $("#" + id).addEventListener("change", refreshBrowseList));
["browse-search", "browse-tag"].forEach((id) =>
  $("#" + id).addEventListener("input", () => {
    clearTimeout(browseDebounce);
    browseDebounce = setTimeout(refreshBrowseList, 250);
  })
);

// Edit modal
let editingId = null;
async function openEditModal(id) {
  const cards = await api.get(`/api/decks/${$("#browse-deck").value}/cards`);
  const card = cards.find((c) => c.id === id);
  if (!card) return;
  editingId = id;
  $("#edit-front").value = card.front;
  $("#edit-back").value = card.back;
  $("#edit-tags").value = card.tags || "";
  $("#edit-modal").classList.remove("hidden");
}
$("#edit-cancel").addEventListener("click", () => $("#edit-modal").classList.add("hidden"));
$("#edit-save").addEventListener("click", async () => {
  try {
    await api.put(`/api/cards/${editingId}`, {
      front: $("#edit-front").value,
      back: $("#edit-back").value,
      tags: $("#edit-tags").value,
    });
    $("#edit-modal").classList.add("hidden");
    refreshBrowseList();
  } catch (e) {
    alert("Could not save: " + e.message);
  }
});

// ---------------------------------------------------------------------------
// Add view
// ---------------------------------------------------------------------------

async function renderAdd() {
  await loadDecks();
  $("#add-deck").innerHTML = state.decks
    .map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`)
    .join("");
  $("#add-status").textContent = "";
}

$("#add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const deckId = $("#add-deck").value;
  if (!deckId) {
    $("#add-status").textContent = "Create a deck first.";
    return;
  }
  try {
    await api.post(`/api/decks/${deckId}/cards`, {
      front: $("#add-front").value,
      back: $("#add-back").value,
      tags: $("#add-tags").value,
    });
    $("#add-front").value = "";
    $("#add-back").value = "";
    $("#add-tags").value = "";
    $("#add-status").textContent = "✓ Card added";
    $("#add-front").focus();
    setTimeout(() => ($("#add-status").textContent = ""), 2000);
  } catch (err) {
    $("#add-status").textContent = "Error: " + err.message;
  }
});

// ---------------------------------------------------------------------------
// Stats view
// ---------------------------------------------------------------------------

async function renderStats() {
  const g = await api.get("/api/stats");
  $("#stats-global").innerHTML = `
    ${statBox(g.total_cards, "total cards")}
    ${statBox(g.due_today, "due today")}
    ${statBox(g.new_today, "new")}
    ${statBox(g.reviewed_today, "reviewed today")}
    ${statBox(g.retention_30d === null ? "—" : g.retention_30d + "%", "retention (30d)")}
    ${statBox(g.total_decks, "decks")}
  `;
  const wrap = $("#stats-decks");
  wrap.innerHTML = "";
  for (const d of state.decks.length ? state.decks : await api.get("/api/decks")) {
    try {
      const s = await api.get(`/api/decks/${d.id}/stats`);
      const div = document.createElement("div");
      div.className = "stat-deck";
      div.innerHTML = `
        <h3>${escapeHtml(s.name)}</h3>
        ${statRow("Total cards", s.total_cards)}
        ${statRow("Due today", s.due_today)}
        ${statRow("New", s.new_today)}
        ${statRow("Reviewed today", s.reviewed_today)}
        ${statRow("Retention (30d)", s.retention_30d === null ? "—" : s.retention_30d + "%")}
      `;
      wrap.appendChild(div);
    } catch (e) {
      /* deck may have been deleted; skip */
    }
  }
}

function statBox(num, lbl) {
  return `<div class="stat-box"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`;
}
function statRow(lbl, val) {
  return `<div class="stat-row"><span>${lbl}</span><b>${val}</b></div>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

renderDecks().catch((e) => {
  $("#deck-list").innerHTML = `<div class="empty">Could not reach the server.<br>${escapeHtml(e.message)}</div>`;
});
