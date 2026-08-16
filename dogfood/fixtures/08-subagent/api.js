// Public API of the item service. The exported functions ARE the public API:
// external consumers depend on these exact signatures. Adding a feature that
// the public API cannot express requires an API change.
import { readStore, writeStore } from './store.js';

export function listItems() {
  return readStore();
}

export function getItem(id) {
  return readStore().find((item) => item.id === id);
}

export function createItem(data) {
  const store = readStore();
  const item = { id: store.length + 1, title: data.title };
  store.push(item);
  writeStore(store);
  return item;
}
