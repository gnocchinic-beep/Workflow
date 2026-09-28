/* Flusso — board kanban personale con time-tracking, multi-bacheca
   Richiede supabase-config.js con URL e chiave anon del tuo progetto Supabase. */

const sb = window.supabase.createClient(
  window.FLUSSO_SUPABASE_URL,
  window.FLUSSO_SUPABASE_ANON_KEY
);

const loginScreen = document.getElementById("login-screen");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const appEl = document.getElementById("app");
const boardEl = document.getElementById("board");
const boardTabsEl = document.getElementById("board-tabs");
const boardNameInput = document.getElementById("board-name-input");
const addColumnBtn = document.getElementById("add-column-btn");
const deleteBoardBtn = document.getElementById("delete-board-btn");
const logoutBtn = document.getElementById("logout-btn");

const columnTemplate = document.getElementById("column-template");
const cardTemplate = document.getElementById("card-template");

let userId = null;
let boards = [];          // [{id, name, position, data: {columns, tasks}}]
let activeBoardId = null;
let dirty = false;
let saveTimeout = null;
let tickInterval = null;
let realtimeChannel = null;

function activeBoard() {
  return boards.find((b) => b.id === activeBoardId);
}

// ---------- AUTH ----------
sb.auth.onAuthStateChange((_event, session) => {
  if (session && session.user) {
    userId = session.user.id;
    loginScreen.hidden = true;
    appEl.hidden = false;
    loadBoards();
    startTicking();
  } else {
    userId = null;
    if (realtimeChannel) sb.removeChannel(realtimeChannel);
    stopTicking();
    appEl.hidden = true;
    loginScreen.hidden = false;
  }
});

sb.auth.getSession().then(({ data }) => {
  if (!data.session) return; // onAuthStateChange gestisce comunque il caso "loggato"
});

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.hidden = true;
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    loginError.textContent = "Accesso non riuscito: " + error.message;
    loginError.hidden = false;
  }
});

logoutBtn.addEventListener("click", () => sb.auth.signOut());

// ---------- CARICAMENTO BACHECHE ----------
async function loadBoards() {
  const { data, error } = await sb
    .from("boards")
    .select("*")
    .order("position", { ascending: true });

  if (error) {
    alert("Errore nel caricamento delle bacheche: " + error.message);
    return;
  }

  if (data.length === 0) {
    const created = await createBoard("Sede principale");
    boards = [created];
  } else {
    boards = data;
  }

  if (!activeBoardId || !boards.some((b) => b.id === activeBoardId)) {
    activeBoardId = boards[0].id;
  }

  renderTabs();
  renderBoard();
  subscribeRealtime();
}

async function createBoard(name) {
  const { data, error } = await sb
    .from("boards")
    .insert({
      name,
      position: Date.now(),
      data: {
        columns: [
          { id: uid_(), title: "Da fare" },
          { id: uid_(), title: "In corso" },
          { id: uid_(), title: "Fatto" },
        ],
        tasks: [],
      },
    })
    .select()
    .single();
  if (error) {
    alert("Errore nella creazione della bacheca: " + error.message);
    return null;
  }
  return data;
}

function subscribeRealtime() {
  if (realtimeChannel) sb.removeChannel(realtimeChannel);
  realtimeChannel = sb
    .channel("boards-sync")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "boards" },
      (payload) => {
        if (dirty) return; // evita di sovrascrivere modifiche locali non ancora salvate
        if (payload.eventType === "DELETE") {
          boards = boards.filter((b) => b.id !== payload.old.id);
        } else {
          const idx = boards.findIndex((b) => b.id === payload.new.id);
          if (idx === -1) boards.push(payload.new);
          else boards[idx] = payload.new;
        }
        if (!boards.some((b) => b.id === activeBoardId) && boards.length > 0) {
          activeBoardId = boards[0].id;
        }
        renderTabs();
        renderBoard();
      }
    )
    .subscribe();
}

// ---------- SALVATAGGIO ----------
function scheduleSave() {
  dirty = true;
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(saveNow, 500);
}

async function saveNow() {
  clearTimeout(saveTimeout);
  const board = activeBoard();
  if (!board) return;
  const { error } = await sb
    .from("boards")
    .update({ name: board.name, data: board.data, updated_at: new Date().toISOString() })
    .eq("id", board.id);
  dirty = false;
  if (error) console.error("Errore nel salvataggio:", error.message);
}

function uid_() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ---------- LINGUETTE BACHECHE ----------
function renderTabs() {
  boardTabsEl.innerHTML = "";
  boards
    .slice()
    .sort((a, b) => a.position - b.position)
    .forEach((b) => {
      const btn = document.createElement("button");
      btn.className = "board-tab" + (b.id === activeBoardId ? " active" : "");
      btn.textContent = b.name || "(senza nome)";
      btn.addEventListener("click", () => {
        activeBoardId = b.id;
        renderTabs();
        renderBoard();
      });
      boardTabsEl.appendChild(btn);
    });

  const addBtn = document.createElement("button");
  addBtn.className = "add-board-tab";
  addBtn.textContent = "+ Bacheca";
  addBtn.title = "Aggiungi una nuova bacheca (es. un'altra sede)";
  addBtn.addEventListener("click", async () => {
    const name = prompt("Nome della nuova bacheca (es. Sede Torino):", "Nuova sede");
    if (!name) return;
    const created = await createBoard(name);
    if (created) {
      boards.push(created);
      activeBoardId = created.id;
      renderTabs();
      renderBoard();
    }
  });
  boardTabsEl.appendChild(addBtn);
}

deleteBoardBtn.addEventListener("click", async () => {
  const board = activeBoard();
  if (!board) return;
  if (boards.length === 1) {
    alert("Non puoi eliminare l'unica bacheca rimasta.");
    return;
  }
  if (!confirm(`Eliminare la bacheca "${board.name}" e tutti i suoi lavori?`)) return;
  const { error } = await sb.from("boards").delete().eq("id", board.id);
  if (error) {
    alert("Errore nell'eliminazione: " + error.message);
    return;
  }
  boards = boards.filter((b) => b.id !== board.id);
  activeBoardId = boards[0].id;
  renderTabs();
  renderBoard();
});

boardNameInput.addEventListener("change", () => {
  const board = activeBoard();
  if (!board) return;
  board.name = boardNameInput.value;
  scheduleSave();
  renderTabs();
});

// ---------- RENDER BACHECA ATTIVA ----------
function renderBoard() {
  const board = activeBoard();
  boardEl.innerHTML = "";
  if (!board) return;
  boardNameInput.value = board.name || "";
  board.data.columns.forEach((col) => boardEl.appendChild(renderColumn(board, col)));
}

function renderColumn(board, col) {
  const node = columnTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.columnId = col.id;

  const titleInput = node.querySelector(".column-title");
  titleInput.value = col.title;
  titleInput.addEventListener("change", () => {
    col.title = titleInput.value;
    scheduleSave();
  });

  node.querySelector(".delete-column-btn").addEventListener("click", () => {
    if (!confirm(`Eliminare la colonna "${col.title}" e le sue schede?`)) return;
    board.data.tasks = board.data.tasks.filter((t) => t.columnId !== col.id);
    board.data.columns = board.data.columns.filter((c) => c.id !== col.id);
    scheduleSave();
    renderBoard();
  });

  const list = node.querySelector(".card-list");
  node.querySelector(".add-card-btn").addEventListener("click", () => {
    const task = {
      id: uid_(),
      title: "",
      desc: "",
      columnId: col.id,
      order: Date.now(),
      timeSpent: 0,
      timerStartedAt: null,
    };
    board.data.tasks.push(task);
    scheduleSave();
    renderBoard();
  });

  list.addEventListener("dragover", (e) => {
    e.preventDefault();
    list.classList.add("drag-over");
  });
  list.addEventListener("dragleave", () => list.classList.remove("drag-over"));
  list.addEventListener("drop", (e) => {
    e.preventDefault();
    list.classList.remove("drag-over");
    const taskId = e.dataTransfer.getData("text/plain");
    const task = board.data.tasks.find((t) => t.id === taskId);
    if (task) {
      task.columnId = col.id;
      task.order = Date.now();
      scheduleSave();
      renderBoard();
    }
  });

  board.data.tasks
    .filter((t) => t.columnId === col.id)
    .sort((a, b) => a.order - b.order)
    .forEach((task) => list.appendChild(renderCard(board, task)));

  return node;
}

function renderCard(board, task) {
  const node = cardTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.taskId = task.id;
  if (task.timerStartedAt) node.classList.add("timing");

  node.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", task.id);
    node.classList.add("dragging");
  });
  node.addEventListener("dragend", () => node.classList.remove("dragging"));

  const titleInput = node.querySelector(".card-title");
  titleInput.value = task.title;
  titleInput.addEventListener("change", () => {
    task.title = titleInput.value;
    scheduleSave();
  });

  const descInput = node.querySelector(".card-desc");
  descInput.value = task.desc;
  descInput.addEventListener("change", () => {
    task.desc = descInput.value;
    scheduleSave();
  });

  node.querySelector(".delete-card-btn").addEventListener("click", () => {
    board.data.tasks = board.data.tasks.filter((t) => t.id !== task.id);
    scheduleSave();
    renderBoard();
  });

  const display = node.querySelector(".timer-display");
  display.textContent = formatDuration(currentElapsed(task));

  node.querySelector(".timer-toggle").addEventListener("click", () => {
    if (task.timerStartedAt) {
      task.timeSpent += Date.now() - task.timerStartedAt;
      task.timerStartedAt = null;
    } else {
      // ferma eventuali altri timer in corso, in questa e nelle altre bacheche
      boards.forEach((b) => {
        b.data.tasks.forEach((t) => {
          if (t.timerStartedAt) {
            t.timeSpent += Date.now() - t.timerStartedAt;
            t.timerStartedAt = null;
          }
        });
      });
      task.timerStartedAt = Date.now();
    }
    scheduleSave();
    renderBoard();
  });

  return node;
}

function currentElapsed(task) {
  return task.timeSpent + (task.timerStartedAt ? Date.now() - task.timerStartedAt : 0);
}

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = String(Math.floor(totalSec / 3600)).padStart(2, "0");
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
  const s = String(totalSec % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function startTicking() {
  tickInterval = setInterval(() => {
    document.querySelectorAll(".card.timing").forEach((node) => {
      const board = activeBoard();
      if (!board) return;
      const task = board.data.tasks.find((t) => t.id === node.dataset.taskId);
      if (task) node.querySelector(".timer-display").textContent = formatDuration(currentElapsed(task));
    });
  }, 1000);
}
function stopTicking() {
  clearInterval(tickInterval);
}

// ---------- AGGIUNGI COLONNA ----------
addColumnBtn.addEventListener("click", () => {
  const board = activeBoard();
  if (!board) return;
  board.data.columns.push({ id: uid_(), title: "Nuova colonna" });
  scheduleSave();
  renderBoard();
});
