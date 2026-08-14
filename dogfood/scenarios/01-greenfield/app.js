"use strict";

/* ============ Taskboard — local-first personal task manager ============ */

const STORAGE_KEY = "taskboard.tasks.v1";

const PRIORITY_LABELS = { high: "High", medium: "Medium", low: "Low" };

const state = {
  tasks: loadTasks(),
  filter: "all",     // all | active | completed
  search: "",
  editingId: null,
};

/* ---------- Storage ---------- */

function loadTasks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidTask);
  } catch {
    return [];
  }
}

function isValidTask(t) {
  return (
    t &&
    typeof t.id === "string" &&
    typeof t.title === "string" &&
    typeof t.completed === "boolean"
  );
}

function saveTasks() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.tasks));
}

/* ---------- Task helpers ---------- */

function newTask(title, due, priority) {
  return {
    id: crypto.randomUUID(),
    title: title.trim(),
    due: due || null,
    priority: ["high", "medium", "low"].includes(priority) ? priority : "none",
    completed: false,
    createdAt: Date.now(),
  };
}

function findTask(id) {
  return state.tasks.find((t) => t.id === id);
}

function getVisibleTasks() {
  const q = state.search.trim().toLowerCase();
  return state.tasks
    .filter((t) => {
      if (state.filter === "active" && t.completed) return false;
      if (state.filter === "completed" && !t.completed) return false;
      if (q && !t.title.toLowerCase().includes(q)) return false;
      return true;
    })
    .sort((a, b) => {
      // Active tasks first, then by due date (undated last), then by creation.
      if (a.completed !== b.completed) return a.completed ? 1 : -1;
      if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1;
      if (a.due && !b.due) return -1;
      if (!a.due && b.due) return 1;
      return b.createdAt - a.createdAt;
    });
}

function isOverdue(task) {
  if (!task.due || task.completed) return false;
  const today = toISODate(new Date());
  return task.due < today;
}

function toISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatDue(due) {
  if (!due) return "";
  const today = toISODate(new Date());
  const tomorrow = toISODate(new Date(Date.now() + 86400000));
  if (due === today) return "Due today";
  if (due === tomorrow) return "Due tomorrow";
  const date = new Date(due + "T00:00:00");
  return "Due " + date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
  });
}

/* ---------- Rendering ---------- */

const els = {
  addForm: document.getElementById("add-form"),
  newTitle: document.getElementById("new-task-title"),
  newDue: document.getElementById("new-task-due"),
  newPriority: document.getElementById("new-task-priority"),
  taskList: document.getElementById("task-list"),
  emptyState: document.getElementById("empty-state"),
  template: document.getElementById("task-template"),
  count: document.getElementById("task-count"),
  clearCompleted: document.getElementById("clear-completed"),
  search: document.getElementById("search"),
  filterBtns: document.querySelectorAll(".filter-btn"),
  editDialog: document.getElementById("edit-dialog"),
  editForm: document.getElementById("edit-form"),
  editTitle: document.getElementById("edit-title"),
  editDue: document.getElementById("edit-due"),
  editPriority: document.getElementById("edit-priority"),
  editCancel: document.getElementById("edit-cancel"),
};

function render() {
  const visible = getVisibleTasks();

  els.taskList.replaceChildren();
  for (const task of visible) {
    els.taskList.appendChild(renderTask(task));
  }

  const activeCount = state.tasks.filter((t) => !t.completed).length;
  const total = state.tasks.length;
  els.count.textContent =
    total === 0
      ? "No tasks yet"
      : `${activeCount} active · ${total - activeCount} completed`;

  els.clearCompleted.hidden = !state.tasks.some((t) => t.completed);

  if (visible.length === 0) {
    els.emptyState.hidden = false;
    els.emptyState.textContent =
      state.tasks.length === 0
        ? "No tasks yet. Add your first one above. ☝️"
        : "No tasks match your filter or search.";
  } else {
    els.emptyState.hidden = true;
  }

  // Keep the checkbox of a completed-while-editing task in sync.
  if (state.editingId && !findTask(state.editingId)) {
    closeEditor();
  }
}

function renderTask(task) {
  const node = els.template.content.firstElementChild.cloneNode(true);
  node.dataset.id = task.id;
  node.classList.toggle("is-completed", task.completed);

  const toggle = node.querySelector(".task-toggle");
  toggle.checked = task.completed;
  toggle.addEventListener("change", () => {
    task.completed = toggle.checked;
    saveTasks();
    render();
  });

  node.querySelector(".task-title").textContent = task.title;

  const dueEl = node.querySelector(".task-due");
  if (task.due) {
    dueEl.textContent = formatDue(task.due);
    dueEl.classList.toggle("is-overdue", isOverdue(task));
  } else {
    dueEl.remove();
  }

  const priorityEl = node.querySelector(".task-priority");
  if (task.priority !== "none") {
    priorityEl.textContent = PRIORITY_LABELS[task.priority];
    priorityEl.classList.add("p-" + task.priority);
  } else {
    priorityEl.remove();
  }

  node.querySelector(".task-edit").addEventListener("click", () => openEditor(task));
  node.querySelector(".task-delete").addEventListener("click", () => {
    state.tasks = state.tasks.filter((t) => t.id !== task.id);
    saveTasks();
    render();
  });

  return node;
}

/* ---------- Add / edit ---------- */

function addTask(title, due, priority) {
  state.tasks.push(newTask(title, due, priority));
  saveTasks();
}

els.addForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const title = els.newTitle.value.trim();
  if (!title) return;
  addTask(title, els.newDue.value, els.newPriority.value);
  els.addForm.reset();
  els.newTitle.focus();
  render();
});

function openEditor(task) {
  state.editingId = task.id;
  els.editTitle.value = task.title;
  els.editDue.value = task.due || "";
  els.editPriority.value = task.priority || "none";
  els.editDialog.showModal();
  els.editTitle.focus();
}

function closeEditor() {
  state.editingId = null;
  els.editDialog.close();
}

els.editForm.addEventListener("submit", () => {
  const task = findTask(state.editingId);
  if (!task) return;
  task.title = els.editTitle.value.trim();
  task.due = els.editDue.value || null;
  task.priority = els.editPriority.value;
  saveTasks();
  closeEditor();
  render();
});

els.editCancel.addEventListener("click", closeEditor);

els.editDialog.addEventListener("click", (event) => {
  if (event.target === els.editDialog) closeEditor();
});

/* ---------- Filter & search ---------- */

els.filterBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    state.filter = btn.dataset.filter;
    els.filterBtns.forEach((b) => b.classList.toggle("is-active", b === btn));
    render();
  });
});

els.search.addEventListener("input", () => {
  state.search = els.search.value;
  render();
});

els.clearCompleted.addEventListener("click", () => {
  state.tasks = state.tasks.filter((t) => !t.completed);
  saveTasks();
  render();
});

/* ---------- Keyboard shortcuts ---------- */

document.addEventListener("keydown", (event) => {
  const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName);
  if (event.key === "/" && !typing) {
    event.preventDefault();
    els.search.focus();
  }
});

/* ---------- Init ---------- */

render();
