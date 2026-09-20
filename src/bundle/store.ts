/**
 * The bundle lives in IndexedDB, because it has to survive the phone being
 * closed, the app being reopened, and there being no network for a week.
 *
 * Raw bytes are stored, not the parsed object. Two reasons: an ArrayBuffer
 * survives structured cloning exactly, and re-parsing on open means the
 * version handshake runs every single time rather than once at download,
 * which is when a stale reader would otherwise slip through.
 */

const DB_NAME = "orca-mobile";
const DB_VERSION = 1;
const STORE = "bundles";

export interface StoredBundle {
  regionId: string;
  bytes: ArrayBuffer;
  savedAt: number;
  filename: string;
  /** The bundle's own generated_at, so a refresh can compare without parsing. */
  generatedAt: string;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "regionId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("could not open storage"));
  });
}

function run<T>(
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = body(tx.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("storage failed"));
        tx.oncomplete = () => db.close();
      }),
  );
}

export function putBundle(entry: StoredBundle): Promise<unknown> {
  return run("readwrite", (s) => s.put(entry));
}

export function getBundle(regionId: string): Promise<StoredBundle | undefined> {
  return run<StoredBundle | undefined>("readonly", (s) => s.get(regionId));
}

export function listBundles(): Promise<StoredBundle[]> {
  return run<StoredBundle[]>("readonly", (s) => s.getAll());
}

export function deleteBundle(regionId: string): Promise<unknown> {
  return run("readwrite", (s) => s.delete(regionId));
}
