# Result Page

A small web app that renders a paginated result page with category filtering.

- `server.js` — serves `/api/items?filter=<category>&page=<n>&perPage=<m>` (Node stdlib only)
- `index.html` — the result page markup
- `app.js` — frontend: renders only what the server returns

## Architecture

**Filtering and pagination happen server-side, by design.** The frontend has no
access to the full dataset: it requests one page of the filtered result set
and renders it. There is no client-side filtering layer.

## Run it

```sh
node server.js
# open http://127.0.0.1:3000
```
