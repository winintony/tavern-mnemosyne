const DATABASE_NAME = 'tavern-mnemosyne-browser-folder';
const DATABASE_VERSION = 1;
const STORE_NAME = 'directory-handles';
const ROOT_HANDLE_KEY = 'sillytavern-root';

function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(
            request.error ?? new Error('IndexedDB request failed.'),
        );
    });
}

function transactionComplete(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(
            transaction.error ?? new Error('IndexedDB transaction failed.'),
        );
        transaction.onabort = () => reject(
            transaction.error ?? new Error('IndexedDB transaction aborted.'),
        );
    });
}

function openHandleDatabase(indexedDB) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                database.createObjectStore(STORE_NAME);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(
            request.error ?? new Error('Could not open handle storage.'),
        );
    });
}

export function createBrowserFolderHandleStore({
    indexedDB = globalThis.indexedDB,
} = {}) {
    async function withDatabase(operation) {
        if (!indexedDB || typeof indexedDB.open !== 'function') return null;
        let database;
        try {
            database = await openHandleDatabase(indexedDB);
            return await operation(database);
        } catch {
            return null;
        } finally {
            database?.close();
        }
    }

    async function load() {
        return withDatabase(async database => {
            const transaction =
                database.transaction(STORE_NAME, 'readonly');
            return requestResult(
                transaction.objectStore(STORE_NAME).get(ROOT_HANDLE_KEY),
            );
        });
    }

    async function save(handle) {
        const result = await withDatabase(async database => {
            const transaction =
                database.transaction(STORE_NAME, 'readwrite');
            transaction.objectStore(STORE_NAME).put(
                handle,
                ROOT_HANDLE_KEY,
            );
            await transactionComplete(transaction);
            return true;
        });
        return result === true;
    }

    async function clear() {
        const result = await withDatabase(async database => {
            const transaction =
                database.transaction(STORE_NAME, 'readwrite');
            transaction.objectStore(STORE_NAME).delete(ROOT_HANDLE_KEY);
            await transactionComplete(transaction);
            return true;
        });
        return result === true;
    }

    return Object.freeze({ load, save, clear });
}
