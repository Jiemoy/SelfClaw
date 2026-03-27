import type { StateStorage } from "zustand/middleware";

interface IndexedDbRecord {
  key: string;
  value: string;
}

const DB_NAME = "selfclaw-indexeddb";
const STORE_NAME = "zustand-store";

let dbPromise: Promise<IDBDatabase> | null = null;

function hasIndexedDb(): boolean {
  return typeof window !== "undefined" && typeof window.indexedDB !== "undefined";
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB"));
  });

  return dbPromise;
}

async function getIndexedDbItem(name: string): Promise<string | null> {
  const db = await openDatabase();
  const transaction = db.transaction(STORE_NAME, "readonly");
  const store = transaction.objectStore(STORE_NAME);
  const record = (await requestToPromise(
    store.get(name)
  )) as IndexedDbRecord | undefined;
  return record?.value ?? null;
}

async function setIndexedDbItem(name: string, value: string): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  store.put({ key: name, value } satisfies IndexedDbRecord);
  await transactionDone(transaction);
}

async function removeIndexedDbItem(name: string): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  store.delete(name);
  await transactionDone(transaction);
}

export const indexedDbStorage: StateStorage = {
  async getItem(name) {
    if (!hasIndexedDb()) {
      return window.localStorage.getItem(name);
    }

    const fromIndexedDb = await getIndexedDbItem(name);
    if (fromIndexedDb !== null) {
      return fromIndexedDb;
    }

    // One-time migration: if old state exists in localStorage, adopt it into IndexedDB.
    const legacy = window.localStorage.getItem(name);
    if (legacy !== null) {
      await setIndexedDbItem(name, legacy);
      window.localStorage.removeItem(name);
      return legacy;
    }

    return null;
  },
  async setItem(name, value) {
    if (!hasIndexedDb()) {
      window.localStorage.setItem(name, value);
      return;
    }
    await setIndexedDbItem(name, value);
  },
  async removeItem(name) {
    if (!hasIndexedDb()) {
      window.localStorage.removeItem(name);
      return;
    }
    await removeIndexedDbItem(name);
  },
};
