/**
 * Keeps tapes and snapshots in IndexedDB (too big for localStorage), so a
 * reload finds everything where it was. One object store, two kinds of key:
 *
 *   "shelf:<name>"  every tape or snapshot ever loaded, to pick again later
 *   "deck"          the cassette in the tape deck, with what SAVE recorded
 */

const DB = 'k-prompt';
const STORE = 'files';
const SHELF = 'shelf:';

export interface StoredFile {
  name: string;
  data: Uint8Array;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return undefined; // private mode or blocked storage: nothing is remembered
  }
}

const put = (key: IDBValidKey, value: StoredFile | null) =>
  run<unknown>('readwrite', (s) => (value ? s.put(value, key) : s.delete(key)) as IDBRequest<unknown>);

export const saveDeck = (tape: StoredFile | null) => put('deck', tape);
export const loadDeck = () => run<StoredFile>('readonly', (s) => s.get('deck'));

export const shelve = (file: StoredFile) => put(SHELF + file.name, file);
export const unshelve = (name: string) => put(SHELF + name, null);
export const loadShelf = async (): Promise<StoredFile[]> => {
  const all = await run<StoredFile[]>('readonly', (s) => s.getAll(IDBKeyRange.bound(SHELF, SHELF + '￿')));
  return (all ?? []).sort((a, b) => a.name.localeCompare(b.name));
};
