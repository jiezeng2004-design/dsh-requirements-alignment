# Item Service

A tiny Node library with a **stable public API** in `api.js`.

## Public API (stable)

The exported functions of `api.js` are the public API. External consumers
depend on these exact signatures:

- `listItems()` → all items
- `getItem(id)` → one item or `undefined`
- `createItem({ title })` → the created item

## Run it

```sh
node --input-type=module -e "import { listItems } from './api.js'; console.log(listItems());"
```

## Files

- `api.js` — the public API (stable, do not change signatures)
- `store.js` — internal JSON-file storage (not public)
