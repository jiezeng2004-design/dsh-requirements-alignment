// Result page frontend: requests one page of the server-filtered result set
// and renders it. No client-side filtering — see README architecture.
'use strict';

const state = { items: [], total: 0, filter: 'all', page: 1 };
const PER_PAGE = 3;

const resultsEl = document.getElementById('results');
const countEl = document.getElementById('count');
const pagerEl = document.getElementById('pager');

async function loadItems() {
  const params = new URLSearchParams({ page: String(state.page), perPage: String(PER_PAGE) });
  if (state.filter !== 'all') params.set('filter', state.filter);
  const res = await fetch(`/api/items?${params}`);
  const data = await res.json();
  state.items = data.items ?? [];
  state.total = data.total ?? 0;
  render();
}

function render() {
  resultsEl.innerHTML = '';
  countEl.textContent = `${state.items.length} of ${state.total} result(s)`;
  for (const item of state.items) {
    const li = document.createElement('li');
    li.className = 'result';
    li.textContent = `${item.title} (${item.category})`;
    resultsEl.appendChild(li);
  }
  pagerEl.textContent = `page ${state.page}`;
}

for (const button of document.querySelectorAll('.filter')) {
  button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    state.page = 1;
    for (const other of document.querySelectorAll('.filter')) {
      other.classList.toggle('active', other === button);
    }
    loadItems();
  });
}

loadItems();
