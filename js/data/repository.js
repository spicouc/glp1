// Capa de repositori: la UI només parla amb aquesta API.
// canviar localStorage per IndexedDB / Supabase / servidor implica escriure un
// altre `adapter` (read/write/async) i no tocar cap vista.

import { freshDb, migrate } from './migrations.js';
import { validateBackup } from '../core/validate.js';
import { normalisePatient } from '../core/model.js';

export const STORAGE_KEY = 'glp1.db.v1';

/** Adaptador localStorage (síncron). */
export const localAdapter = {
  name: 'localStorage',
  read() {
    return window.localStorage.getItem(STORAGE_KEY);
  },
  write(text) {
    window.localStorage.setItem(STORAGE_KEY, text);
  },
  clear() {
    window.localStorage.removeItem(STORAGE_KEY);
  },
};

/** Adaptador en memòria (tests). */
export function memoryAdapter(seed = null) {
  let store = seed;
  return {
    name: 'memory',
    read: () => store,
    write: (text) => {
      store = text;
    },
    clear: () => {
      store = null;
    },
    get raw() {
      return store;
    },
  };
}

export function createRepository(adapter) {
  let cache = null;
  let cacheRaw = null;

  function load() {
    const raw = adapter.read();
    if (raw === cacheRaw && cache) return cache;
    if (!raw) {
      cache = freshDb();
      cacheRaw = null;
      return cache;
    }
    try {
      cache = migrate(JSON.parse(raw));
    } catch (err) {
      const e = new Error(`No s'ha pogut carregar la base de dades: ${err.message}`);
      e.cause = err;
      throw e;
    }
    cacheRaw = raw;
    return cache;
  }

  function persist(db) {
    const text = JSON.stringify(db);
    try {
      adapter.write(text);
    } catch (err) {
      const e = new Error(
        `No s'ha pogut desar (${adapter.name}): ${err.name === 'QuotaExceededError' ? "s'ha superat l'espai disponible del navegador. Exporta la base de dades." : err.message}`
      );
      e.cause = err;
      throw e;
    }
    cache = db;
    cacheRaw = text;
    return db;
  }

  function byUpdatedAt(a, b) {
    return String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || String(b.id).localeCompare(String(a.id));
  }

  return {
    adapter,
    /**
     * Llistat de pacients. Per defecte NO inclou els esborrats (tombes);
     * `list({ includeDeleted: true })` els inclou per a la sincronització.
     */
    list({ includeDeleted = false } = {}) {
      const rows = [...load().patients].sort(byUpdatedAt);
      return includeDeleted ? rows : rows.filter((p) => !p.deletedAt);
    },
    get(id) {
      return load().patients.find((p) => p.id === id) || null;
    },
    save(patient) {
      const db = load();
      const normalised = normalisePatient(patient);
      const idx = db.patients.findIndex((p) => p.id === normalised.id);
      normalised.updatedAt = new Date().toISOString();
      if (idx >= 0) db.patients[idx] = normalised;
      else db.patients.push(normalised);
      persist({ ...db, patients: [...db.patients] });
      return normalised;
    },
    /**
     * Esborrat SOFT: es marca la tomba (`deletedAt`) i s'incrementa
     * `updatedAt` perquè el canvi es propagui als altres dispositius.
     * La tomba s'elimina del servidor passats 30 dies.
     */
    remove(id) {
      const db = load();
      const idx = db.patients.findIndex((p) => p.id === id);
      if (idx < 0 || db.patients[idx].deletedAt) return false; // idempotent
      const now = new Date().toISOString();
      const updated = [...db.patients];
      updated[idx] = { ...updated[idx], deletedAt: now, updatedAt: now };
      persist({ ...db, patients: updated });
      return true;
    },
    exportAll() {
      const db = load();
      return {
        app: 'glp1',
        schemaVersion: db.schemaVersion,
        exportedAt: new Date().toISOString(),
        // la còpia de seguretat no inclou esborrats
        patients: db.patients.filter((p) => !p.deletedAt),
      };
    },
    exportPatient(id) {
      const p = this.get(id);
      if (!p) return null;
      return {
        app: 'glp1',
        schemaVersion: load().schemaVersion,
        exportedAt: new Date().toISOString(),
        kind: 'patient',
        patients: [p],
      };
    },
    /** Substitueix la llista sencera (usat per la sincronització servidor). */
    replaceAll(patients) {
      const db = load();
      persist({ ...db, patients: (patients || []).map(normalisePatient) });
      return true;
    },
    /** mode: 'replace' (sustitueix tot) | 'merge' (afegeix els que no hi són). */
    importBackup(data, mode = 'merge') {
      const check = validateBackup(data);
      if (!check.ok) return { ...check, added: 0, updated: 0, skipped: 0 };

      // Esquema antic → es migra abans d'escriure
      const source = migrate(data);
      const db = load();
      let added = 0;
      let updated = 0;
      let skipped = 0;
      const incoming = source.patients.map(normalisePatient);

      if (mode === 'replace') {
        persist({ ...db, patients: incoming });
        return { ...check, added: incoming.length, updated: 0, skipped: 0 };
      }

      const patients = [...db.patients];
      for (const p of incoming) {
        const idx = patients.findIndex((x) => x.id === p.id);
        if (idx >= 0) {
          patients[idx] = p;
          updated += 1;
        } else {
          // Mateix codi però altre id: es conserva el registre existent i
          // l'entrant entra amb codi nou per no trencar la identitat visible.
          if (patients.some((x) => x.code === p.code)) p.code = `${p.code}*`;
          added += 1;
          patients.push(p);
        }
      }
      persist({ ...db, patients });
      return { ...check, added, updated, skipped };
    },
    reset() {
      persist(freshDb());
    },
    usage() {
      const raw = adapter.read() || '';
      return { bytes: new Blob([raw]).size, key: STORAGE_KEY, adapter: adapter.name };
    },
  };
}
