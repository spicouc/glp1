// Encaminador hash: #/ , #/p/:id , #/p/:id/:tab
// Cada canvi de ruta provoca un re-render complet (l'app és petita i local).

import { state, update } from './state.js';

export const TABS = ['calendar', 'treatment', 'pens', 'health', 'history'];

export function parseHash(hash = window.location.hash) {
  const raw = (hash || '').replace(/^#/, '');
  const parts = raw.split('/').filter(Boolean);
  if (parts[0] === 'p' && parts[1]) {
    const tab = parts[2] && TABS.includes(parts[2]) ? parts[2] : 'calendar';
    return { name: 'patient', params: { id: decodeURIComponent(parts[1]), tab } };
  }
  if (parts[0] === 'admin') return { name: 'admin', params: {} };
  if (parts[0] === 'backup') return { name: 'backup', params: {} };
  return { name: 'patients', params: {} };
}

export function patientsPath() {
  return '#/';
}

export function patientPath(id, tab = 'calendar') {
  return `#/p/${encodeURIComponent(id)}/${tab}`;
}

export function navigate(path, { replace = false } = {}) {
  if (replace) window.history.replaceState(null, '', path);
  else window.location.hash = path;
  if (replace) {
    state.route = parseHash();
    update('route');
  }
}

let started = false;

export function startRouter() {
  if (started) {
    state.route = parseHash();
    return state.route;
  }
  started = true;
  const handle = () => {
    state.route = parseHash();
    update('route');
  };
  window.addEventListener('hashchange', handle);
  state.route = parseHash();
  return state.route;
}
