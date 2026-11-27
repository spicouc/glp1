// Punt d'entrada: sessió → catàleg → baixada de dades → render.

import { h, clear, btn, icon } from './ui/dom.js';
import { t } from './i18n/index.js';
import { state, update, onChange, loadPatients } from './ui/state.js';
import { startRouter, navigate, patientsPath } from './ui/router.js';
import { renderPatients } from './ui/views/patients.js';
import { renderPatient } from './ui/views/patient.js';
import { renderAdmin } from './ui/views/admin.js';
import { renderLogin } from './ui/views/login.js';
import { api } from './data/api.js';
import { fullSync, onSyncChange, sync } from './data/sync.js';
import { setDrugCatalog } from './core/drugs.js';
import { toast } from './ui/modal.js';

let listenersAttached = false;

/** Versió d'aquesta còpia del codi; el servidor l'anuncia a /me (capabilities). */
const APP_VERSION = '1.1.0';

/**
 * Hi ha una versió nova al servidor? L'avís és discreu (toast amb acció) per no
 * interrompre res, però recarregar és important: una pestanya amb codi vell
 * podria pujar un document sense els camps nous de l'esquema.
 */
function promptNewVersion(me) {
  const server = me && me.capabilities ? me.capabilities.appVersion : null;
  if (!server || server === APP_VERSION) return;
  let shown = null;
  try { shown = window.sessionStorage.getItem('glp1.versionPrompt'); } catch { /* mode privat */ }
  if (shown === server) return; // un avís per sessió
  try { window.sessionStorage.setItem('glp1.versionPrompt', server); } catch { /* … */ }
  toast(t('app.newVersion', { from: APP_VERSION, to: server }), {
    tone: 'warn',
    actionLabel: t('app.reload'),
    onAction: () => window.location.reload(),
    duration: 20000,
  });
}

function bootError(message) {
  const el = root();
  if (!el) return;
  clear(el).appendChild(
    h('div', { class: 'view view--error' },
      h('div', { class: 'empty' },
        icon('alert'),
        h('p', { class: 'empty__title' }, t('app.error')),
        h('p', { class: 'empty__hint' }, message),
        btn(t('app.retry'), { variant: 'primary', onClick: () => window.location.reload() }))
    )
  );
}

/**
 * Raons de re-renderització que arriben SOLES (sense que l'usuari hagi tocat
 * res): la sincronització en segon pla (debounce de 900 ms) i la proposta
 * automàtica de la primera visita al mode Pla.
 */
const BACKGROUND_REASONS = new Set(['sync', 'plan-standard']);

/** Hi ha un camp de formulari a mig omplir? (llavors NO s'ha d'esborrar) */
function editingInProgress() {
  const active = document.activeElement;
  if (!active || !/^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName)) return false;
  return Boolean(active.closest('form'));
}

/**
 * Identitat d'un element: serveix per assegurar que, en restaurar el focus o
 * un scroll, estem davant del MATEIX camp i no d'un altre de la mateixa ruta.
 */
function identityOf(node) {
  return [
    node.tagName,
    node.getAttribute('name') || '',
    node.getAttribute('aria-label') || '',
    node.getAttribute('type') || '',
    node.className || '',
  ].join('|');
}

/** Ruta de l'element dins de l'arrel (estable entre dues renderitzacions). */
function elementPath(node, scope) {
  const parts = [];
  let cur = node;
  while (cur && cur !== scope) {
    const parent = cur.parentElement;
    const same = parent ? [...parent.children].filter((c) => c.tagName === cur.tagName) : [];
    parts.unshift(`${cur.tagName.toLowerCase()}:${same.indexOf(cur)}`);
    cur = parent;
  }
  return parts.join('/');
}

function findByPath(path, scope) {
  let cur = scope;
  for (const part of path.split('/')) {
    if (!cur) return null;
    const sep = part.lastIndexOf(':');
    const same = [...cur.children]
      .filter((c) => c.tagName && c.tagName.toLowerCase() === part.slice(0, sep));
    cur = same[Number(part.slice(sep + 1))];
  }
  return cur || null;
}

/**
 * On érem abans de substituir tota la vista: scroll de la pàgina, scroll dels
 * contenidors interns (barra d'eines, llistes) i el camp enfocat amb el cursor.
 * Sense això, editar el pla (dosi, interval, data…) re-renderitzava a cada
 * tecla: es perdia el focus, el cursor tornava a l'inici i la pàgina saltava a
 * dalt de tot —«et repagina tota l'estona».
 */
function captureView(scope) {
  const active = document.activeElement;
  const focus = active && scope.contains(active)
    ? {
        path: elementPath(active, scope),
        identity: identityOf(active),
        start: typeof active.selectionStart === 'number' ? active.selectionStart : null,
        end: typeof active.selectionEnd === 'number' ? active.selectionEnd : null,
      }
    : null;

  const scrolls = [];
  for (const node of scope.querySelectorAll('*')) {
    if (node.scrollLeft || node.scrollTop) {
      scrolls.push({ path: elementPath(node, scope), identity: identityOf(node), left: node.scrollLeft, top: node.scrollTop });
      if (scrolls.length >= 40) break;
    }
  }
  return { focus, scrolls, pageY: window.scrollY };
}

/** Torna a posar scroll, focus i cursor tal com estaven (si encara hi són). */
function restoreView(scope, keep) {
  if (!keep) return;
  window.scrollTo(0, keep.pageY);

  for (const s of keep.scrolls) {
    const node = findByPath(s.path, scope);
    if (node && identityOf(node) === s.identity) {
      node.scrollLeft = s.left;
      node.scrollTop = s.top;
    }
  }

  if (keep.focus) {
    const node = findByPath(keep.focus.path, scope);
    if (node && identityOf(node) === keep.focus.identity) {
      node.focus({ preventScroll: true });
      if (keep.focus.start != null) {
        try { node.setSelectionRange(keep.focus.start, keep.focus.end); } catch { /* camps numèrics */ }
      }
      window.scrollTo(0, keep.pageY); // el focus pot haver mogut la pàgina
    }
  }
}

/** Ruta actual; canvia quan l'usuari navega (aleshores sí que es va a dalt). */
let lastRouteKey = null;
const routeKeyOf = (route) => `${route.name}|${JSON.stringify(route.params || {})}`;

function render(reason = 'state') {
  const el = root();
  if (!el) return;
  const route = state.route;
  const routeKey = routeKeyOf(route);
  const routeChanged = routeKey !== lastRouteKey;

  // Un refresh en segon pla no pot esborrar el que s'està escrivint: la
  // re-renderització substitueix tota la vista i els camps tornarien als
  // valors per defecte (es perdia, per exemple, l'edició d'una fase). Es
  // refrescarà amb el següent canvi real.
  if (!routeChanged && BACKGROUND_REASONS.has(reason) && editingInProgress()) return;

  try {
    const view = route.name === 'admin'
      ? renderAdmin()
      : route.name === 'patient'
        ? renderPatient(route.params)
        : renderPatients();

    // On érem abans de substituir-ho tot (només si continuem a la mateixa ruta)
    const keep = routeChanged ? null : captureView(el);

    clear(el);
    el.appendChild(view);
    document.title = `${route.name === 'patient' ? route.params.id : route.name === 'admin' ? t('admin.title') : t('nav.patients')} · ${t('app.title')}`;
    if (routeChanged) {
      lastRouteKey = routeKey;
      if (route.name === 'patient') window.scrollTo(0, 0);
    } else {
      restoreView(el, keep);
    }
  } catch (err) {
    console.error(err);
    clear(el).appendChild(
      h('div', { class: 'view view--error' },
        h('div', { class: 'empty' },
          icon('alert'),
          h('p', { class: 'empty__title' }, t('app.error')),
          h('p', { class: 'empty__hint' }, String(err && err.message ? err.message : err)),
          btn(t('app.retry'), { variant: 'primary', onClick: () => render() }))
      )
    );
  }
}

function root() {
  return document.getElementById('app-root');
}

function showLogin(message = '') {
  lastRouteKey = null; // en tornar a entrar, la ruta "canvia" i es va a dalt
  clear(root()).appendChild(renderLogin({ message, onSuccess: () => boot() }));
}

function attachListeners() {
  if (listenersAttached) return;
  listenersAttached = true;

  onChange(render);
  onSyncChange((s) => {
    if (s.status === 'unauthorised') {
      showLogin(t('login.expired'));
      return;
    }
    if (s.status === 'synced') loadPatients();
    update('sync');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.body.classList.contains('has-dialog')) return;
    if (state.route.name === 'patient') navigate(patientsPath(), { replace: false });
  });
}

async function boot() {
  const el = root();
  if (!el) return;

  // 1) Sessió: sense token, no es carrega cap dada.
  if (!api.getToken()) {
    lastRouteKey = null;
    clear(el).appendChild(renderLogin({ onSuccess: () => boot() }));
    return;
  }
  try {
    const me = await api.me();
    sync.user = me.user;
    sync.passwordIsDefault = Boolean(me.passwordIsDefault);
    promptNewVersion(me);
  } catch (err) {
    if (err && err.status === 401) {
      clear(el).appendChild(renderLogin({ message: t('login.expired'), onSuccess: () => boot() }));
      return;
    }
    // Sense servidor: es continua amb la còpia local
    sync.status = 'offline';
    sync.error = err && err.message ? err.message : null;
  }

  // 2) Catàleg de fàrmacs (les edicions de l'administració guanyen al base)
  if (sync.status !== 'offline') {
    try {
      const data = await api.getDrugs();
      if (Array.isArray(data.drugs) && data.drugs.length) setDrugCatalog(data.drugs);
    } catch (err) {
      if (err && (err.status === 0)) sync.status = 'offline';
    }
  }

  // 3) Baixada: servidor primer, local com a còpia de recerca
  if (sync.status !== 'offline') {
    await fullSync();
    if (sync.status === 'unauthorised') {
      clear(el).appendChild(renderLogin({ message: t('login.expired'), onSuccess: () => boot() }));
      return;
    }
  }

  // 4) Dades locals (semple disponibles, també offline)
  try {
    loadPatients();
  } catch (err) {
    bootError(String(err && err.message ? err.message : err));
    return;
  }

  attachListeners();
  startRouter();
  render();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { boot(); });
} else {
  boot();
}
