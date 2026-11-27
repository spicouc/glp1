// Sincronització: servidor (font de veritat) + còpia local de recerca.
//
//  - pull: baixa els pacients del servidor i els fusiona amb els locals per
//    `updatedAt` (guanya el més recent; mai es perd cap registre).
//  - push: envia els locals; el servidor fa el mateix merge.
//  - Si el servidor no respon → estat 'offline' i es treballa amb la còpia local.
//
// Els rederitzats es notifiquen amb onSyncChange (app.js els subscriu).

import { api } from './api.js';
import { repo } from './localRepository.js';

export const sync = {
  status: 'idle', // idle | syncing | synced | offline | unauthorised | error | no-session
  lastSync: null,
  error: null,
  stats: null,
  busy: false,
  user: null,
  passwordIsDefault: false,
};

const listeners = new Set();

export function onSyncChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn(sync);
}

/** Marca d'actualització d'un pacient (ISO → comparable com a string). */
export function stamp(p) {
  return String((p && (p.updatedAt || p.createdAt)) || '');
}

/**
 * Fusiona les dues llistes per id: guanya el `updatedAt` més recent.
 * Retorna el merge i quins ids s'han tret de cada banda.
 */
export function mergePatientLists(local = [], remote = []) {
  const byId = new Map();
  const put = (p) => {
    if (!p || !p.id) return;
    const current = byId.get(p.id);
    if (!current || stamp(p) > stamp(current)) byId.set(p.id, p);
  };
  remote.forEach(put);
  local.forEach(put);

  const remoteById = new Map(remote.map((p) => [p.id, p]));
  const localById = new Map(local.map((p) => [p.id, p]));

  const pulled = local.filter((l) => {
    const r = remoteById.get(l.id);
    return r && stamp(r) > stamp(l);
  }).map((p) => p.id);

  const localNewer = local.filter((l) => {
    const r = remoteById.get(l.id);
    return !r || stamp(l) > stamp(r);
  }).map((p) => p.id);

  const created = remote.filter((r) => !localById.has(r.id)).map((p) => p.id);

  return { merged: [...byId.values()], pulled, localNewer, created };
}

export async function pullFromServer() {
  const data = await api.getPatients();
  const remote = Array.isArray(data.patients) ? data.patients : [];
  const local = repo.list({ includeDeleted: true }); // les tombes han d'arribar
  const result = mergePatientLists(local, remote);
  repo.replaceAll(result.merged);
  return { ...result, serverAt: data.updatedAt || null };
}

export async function pushToServer() {
  const local = repo.list({ includeDeleted: true });
  const res = await api.putPatients(local);
  // el servidor respon amb l'estat fusionat (pot portar canvis d'altres dispositius)
  if (Array.isArray(res.patients)) repo.replaceAll(res.patients);
  return res;
}

/**
 * Sincronització completa: baixa, fusiona i puja el que falti.
 * Idempotent; es pot cridar després de cada desat.
 */
export async function fullSync({ silent = false } = {}) {
  if (sync.busy) return sync;
  if (!api.getToken()) {
    sync.status = 'no-session';
    if (!silent) emit();
    return sync;
  }
  sync.busy = true;
  sync.status = 'syncing';
  if (!silent) emit();

  try {
    const pulled = await pullFromServer();
    const pushed = await pushToServer();
    sync.status = 'synced';
    sync.error = null;
    sync.lastSync = new Date().toISOString();
    sync.stats = { pulled: pulled.pulled.length, created: pushed.created || 0 };
  } catch (err) {
    sync.error = err && err.message ? err.message : 'Error desconegut';
    if (err && err.status === 401) sync.status = 'unauthorised';
    else if (err && err.status === 0) sync.status = 'offline';
    else sync.status = 'error';
  } finally {
    sync.busy = false;
    if (!silent) emit();
  }
  return sync;
}

let timer = null;

/** Envia els canvis al servidor (debounce) després de cada desat local. */
export function scheduleSync(delay = 900) {
  if (!api.getToken()) return;
  // En desar, l'indicador passa a "Pendent" fins que el servidor confirma:
  // així no es veu "Sincronitzat" abans d'hora.
  sync.status = 'pending';
  emit();
  clearTimeout(timer);
  timer = setTimeout(() => {
    fullSync({ silent: false }).catch(() => {});
  }, delay);
}

/** Estat per a la interfície. */
export function syncLabel() {
  switch (sync.status) {
    case 'syncing': return { text: 'Sincronitzant…', tone: 'muted' };
    case 'pending': return { text: 'Pendent de pujar', tone: 'warn' };
    case 'synced': return { text: 'Sincronitzat', tone: 'ok' };
    case 'offline': return { text: 'Sense servidor · còpia local', tone: 'warn' };
    case 'unauthorised': return { text: 'Sessió caducada', tone: 'danger' };
    case 'error': return { text: 'Error de sincronització', tone: 'danger' };
    case 'no-session': return { text: 'Sense sessió', tone: 'muted' };
    default: return { text: 'Pendent', tone: 'muted' };
  }
}
