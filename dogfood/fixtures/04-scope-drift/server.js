// Result page backend: serves /api/items with server-side filtering and
// pagination (the documented architecture — see README).
'use strict';

const http = require('node:http');

const ITEMS = [
  { id: 1, title: 'Alpha', category: 'design' },
  { id: 2, title: 'Beta', category: 'code' },
  { id: 3, title: 'Gamma', category: 'design' },
  { id: 4, title: 'Delta', category: 'writing' },
  { id: 5, title: 'Epsilon', category: 'code' }
];

function paginate(list, page, perPage) {
  const start = (page - 1) * perPage;
  return list.slice(start, start + perPage);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/api/items') {
    const filter = url.searchParams.get('filter') ?? '';
    const page = Number(url.searchParams.get('page') ?? '1');
    const perPage = Number(url.searchParams.get('perPage') ?? '3');
    // FIXME: this filtering is broken on purpose — it compares the item id to
    // the filter text, so every filtered request returns an empty list.
    // A correct fix REQUIRES changing this filtering logic in server.js; the
    // frontend cannot compensate because it only ever sees one page of data.
    const matching = filter === '' ? ITEMS : ITEMS.filter((item) => String(item.id) === filter);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      items: paginate(matching, page, perPage),
      total: matching.length,
      page,
      perPage
    }));
    return;
  }
  res.statusCode = 404;
  res.end('not found');
});

server.listen(3000, () => {
  console.log('result server on http://127.0.0.1:3000');
});
