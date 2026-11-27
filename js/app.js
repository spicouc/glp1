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

function render() {
  const el = root();
  if (!el) return;
  try {
    const route = state.route;
    const view = route.name === 'admin'
      ? renderAdmin()
      : route.name === 'patient'
        ? renderPatient(route.params)
        : renderPatients();

    clear(el);
    el.appendChild(view);
    document.title = `${route.name === 'patient' ? route.params.id : route.name === 'admin' ? t('admin.title') : t('nav.patients')} · ${t('app.title')}`;
    if (route.name === 'patient') window.scrollTo(0, 0);
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
