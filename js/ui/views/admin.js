// Panell d'administració: usuaris, tokens d'API i catàleg de fàrmacs.

import { h, btn, iconBtn, chip, emptyState, sectionCard, icon } from '../dom.js';
import { openDialog, confirmDialog, toast, formError, clearFormError } from '../modal.js';
import { t } from '../../i18n/index.js';
import { api, ApiError, getCapabilities } from '../../data/api.js';
import { sync } from '../../data/sync.js';
import { state, update } from '../state.js';
import { navigate, patientsPath } from '../router.js';
import { drugList, getDrug, setDrugCatalog, serializeDrug, CATALOG_VERSION } from '../../core/drugs.js';

let tab = 'users'; // users | tokens | drugs | audit
let users = null;
let tokens = null;
let loading = { users: false, tokens: false };
let error = null;

function guard() {
  if (!sync.user) return emptyState(t('login.required'), null, btn(t('login.enter'), { variant: 'primary', onClick: () => window.location.reload() }));
  if (!sync.user.is_admin) {
    return emptyState(t('admin.needAdmin'), null,
      btn(t('nav.patients'), { variant: 'primary', onClick: () => navigate(patientsPath()) }));
  }
  return null;
}

function loadUsers() {
  if (users || loading.users) return;
  loading.users = true;
  api.getUsers()
    .then((d) => { users = d.users || []; error = null; })
    .catch((e) => { error = e.message; })
    .finally(() => { loading.users = false; update('admin-users'); });
}

function loadTokens() {
  if (tokens || loading.tokens) return;
  loading.tokens = true;
  api.listTokens()
    .then((d) => { tokens = d.tokens || []; error = null; })
    .catch((e) => { error = e.message; })
    .finally(() => { loading.tokens = false; update('admin-tokens'); });
}

function refreshUsers() { users = null; loadUsers(); update('admin'); }
function refreshTokens() { tokens = null; loadTokens(); update('admin'); }

/* ------------------------------------------------------------------ usuaris */
function createUserForm() {
  const username = h('input', { class: 'input', name: 'username', autocomplete: 'off', autocapitalize: 'none' });
  const password = h('input', { class: 'input', name: 'password', type: 'password', autocomplete: 'new-password' });
  const isAdmin = h('input', { type: 'checkbox', name: 'is_admin' });
  const errorSlot = h('div', { class: 'form__errors' });

  const form = h('form', { class: 'form', novalidate: true },
    h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('admin.username')), username),
    h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('admin.password')), password, h('span', { class: 'field__hint' }, t('admin.passwordHint'))),
    h('label', { class: 'switch' }, isAdmin, h('span', {}, t('admin.isAdmin'))),
    errorSlot,
    h('div', { class: 'row row--end' }, btn(t('admin.create'), { variant: 'primary', type: 'submit', icon: 'plus' }))
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearFormError(form);
    try {
      await api.createUser({ username: username.value.trim(), password: password.value, is_admin: isAdmin.checked });
      toast(t('admin.userCreated', { name: username.value.trim() }), { tone: 'ok' });
      close();
      refreshUsers();
    } catch (err) {
      errorSlot.replaceChildren(formError(err.message));
    }
  });

  const { close } = openDialog({
    title: t('admin.newUser'),
    body: form,
    actions: [btn(t('app.cancel'), { variant: 'ghost', onClick: () => close() })],
  });
}

function changePasswordDialog(user) {
  const password = h('input', { class: 'input', name: 'password', type: 'password', autocomplete: 'new-password' });
  const errorSlot = h('div', { class: 'form__errors' });
  const form = h('form', { class: 'form', novalidate: true },
    h('p', { class: 'muted small' }, t('admin.changePasswordFor', { name: user.username })),
    h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('admin.newPassword')), password),
    errorSlot);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearFormError(form);
    try {
      await api.patchUser(user.id, { password: password.value });
      toast(t('admin.passwordChanged'), { tone: 'ok' });
      if (sync.user && sync.user.id === user.id) sync.passwordIsDefault = false;
      close();
      refreshUsers();
    } catch (err) {
      errorSlot.replaceChildren(formError(err.message));
    }
  });

  const { close } = openDialog({
    title: t('admin.changePassword'),
    body: form,
    actions: [
      btn(t('app.cancel'), { variant: 'ghost', onClick: () => close() }),
      btn(t('app.save'), { variant: 'primary', onClick: () => form.requestSubmit() }),
    ],
  });
}

function usersPanel() {
  loadUsers();
  const rows = !users
    ? h('p', { class: 'muted' }, t('app.loading'))
    : h('ul', { class: 'records' },
        users.map((u) =>
          h('li', { class: 'record' },
            h('div', { class: 'record__head' },
              h('span', { class: 'record__date' }, u.username),
              h('span', { class: 'badges' },
                u.is_admin ? chip(t('admin.roleAdmin'), { tone: 'ok' }) : chip(t('admin.roleUser'), { tone: 'muted' }),
                u.disabled ? chip(t('admin.disabled'), { tone: 'danger' }) : null)),
            h('p', { class: 'muted small' }, `${t('admin.created')} ${u.created_at ? String(u.created_at).slice(0, 10) : '—'}`),
            h('div', { class: 'row' },
              btn(t('admin.changePassword'), { variant: 'ghost', icon: 'edit', onClick: () => changePasswordDialog(u) }),
              btn(u.disabled ? t('admin.enable') : t('admin.disable'), {
                variant: u.disabled ? 'ghost' : 'secondary',
                onClick: async () => {
                  if (u.id === sync.user.id) { toast(t('admin.cannotSelfDisable'), { tone: 'warn' }); return; }
                  try {
                    await api.patchUser(u.id, { disabled: !u.disabled });
                    refreshUsers();
                  } catch (err) { toast(err.message, { tone: 'error' }); }
                },
              }),
              btn(t('admin.delete'), {
                variant: 'danger', icon: 'trash',
                onClick: async () => {
                  if (u.id === sync.user.id) { toast(t('admin.cannotSelfDelete'), { tone: 'warn' }); return; }
                  const ok = await confirmDialog(t('admin.deleteConfirm', { name: u.username }), {
                    danger: true, okLabel: t('admin.delete'),
                  });
                  if (!ok) return;
                  try {
                    const data = await api.deleteUser(u.id);
                    users = data.users || [];
                    update('admin-user-deleted');
                    toast(t('admin.deleted'), { tone: 'ok' });
                  } catch (err) { toast(err.message, { tone: 'error' }); }
                },
              })))) );

  return sectionCard(
    t('admin.users'),
    error ? h('div', { class: 'notice notice--error' }, icon('alert'), h('div', {}, error)) : null,
    h('div', { class: 'row row--start' }, btn(t('admin.newUser'), { variant: 'primary', icon: 'plus', onClick: createUserForm })),
    rows
  );
}

/* ------------------------------------------------------------------ tokens */
function createTokenForm() {
  const label = h('input', { class: 'input', name: 'label', value: '' });
  const userSelect = h('select', { class: 'input', name: 'user_id' },
    (users || []).map((u) => h('option', { value: u.id, selected: sync.user && u.id === sync.user.id }, u.username)));
  const errorSlot = h('div', { class: 'form__errors' });

  const form = h('form', { class: 'form', novalidate: true },
    h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('admin.tokenLabel')), label, h('span', { class: 'field__hint' }, t('admin.tokenLabelHint'))),
    (users && users.length > 1)
      ? h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('admin.tokenUser')), userSelect)
      : null,
    errorSlot);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearFormError(form);
    try {
      const data = await api.createToken(label.value.trim() || 'API', userSelect.value || undefined);
      tokens = data.tokens || tokens;
      close();
      showTokenOnce(data.token);
      update('admin-token-created');
    } catch (err) {
      errorSlot.replaceChildren(formError(err.message));
    }
  });

  const { close } = openDialog({
    title: t('admin.newToken'),
    body: form,
    actions: [
      btn(t('app.cancel'), { variant: 'ghost', onClick: () => close() }),
      btn(t('admin.createToken'), { variant: 'primary', onClick: () => form.requestSubmit() }),
    ],
  });
}

function showTokenOnce(token) {
  const input = h('input', { class: 'input', value: token, readonly: true, onFocus: (e) => e.target.select() });
  openDialog({
    title: t('admin.tokenOnce'),
    body: h('div', { class: 'stack stack--tight' },
      h('div', { class: 'notice notice--warn' }, icon('alert'), h('div', {}, t('admin.tokenOnceBody'))),
      input),
    actions: [btn(t('app.close'), { variant: 'primary', onClick: () => {} })],
  });
}

function tokensPanel() {
  loadTokens();
  const rows = !tokens
    ? h('p', { class: 'muted' }, t('app.loading'))
    : tokens.length === 0
      ? h('p', { class: 'muted' }, t('admin.noTokens'))
      : h('ul', { class: 'records' },
          tokens.map((tk) =>
            h('li', { class: 'record' },
              h('div', { class: 'record__head' },
                h('span', { class: 'record__date' }, tk.label || t('admin.tokenGeneric')),
                tk.revoked ? chip(t('admin.revoked'), { tone: 'danger' }) : chip(t('admin.active'), { tone: 'ok' })),
              h('p', { class: 'muted small' },
                `${tk.username} · ${t('admin.created')} ${String(tk.created_at || '').slice(0, 10)}` +
                `${tk.last_used_at ? ` · ${t('admin.lastUsed')} ${String(tk.last_used_at).slice(0, 16).replace('T', ' ')}` : ''}`),
              tk.revoked ? null : h('div', { class: 'row' },
                btn(t('admin.revoke'), {
                  variant: 'danger', icon: 'trash',
                  onClick: async () => {
                    const ok = await confirmDialog(t('admin.revokeConfirm'), { okLabel: t('admin.revoke') });
                    if (!ok) return;
                    try { const d = await api.revokeToken(tk.id); tokens = d.tokens || tokens; refreshTokens(); toast(t('admin.tokenRevoked'), { tone: 'ok' }); }
                    catch (err) { toast(err.message, { tone: 'error' }); }
                  },
                })))) );

  return sectionCard(
    t('admin.tokens'),
    h('p', { class: 'muted small' }, t('admin.tokensHint')),
    h('div', { class: 'row row--start' }, btn(t('admin.newToken'), { variant: 'primary', icon: 'plus', onClick: createTokenForm })),
    rows
  );
}

/* ------------------------------------------------------------------ fàrmacs */
function drugsPanel() {
  const list = drugList();
  const cards = list.map((d) => {
    const doses = (d.standardDosesMg || []).join(', ');
    const optional = (d.optionalMaintenanceMg || []).join(', ');
    return h('div', { class: 'drugcard', dataset: { id: d.id } },
      h('div', { class: 'drugcard__head' },
        h('strong', {}, d.label || d.id),
        h('span', { class: 'muted small' }, `${d.activeSubstance || ''} · ${d.clickMode}`)),
      h('div', { class: 'field' },
        h('span', { class: 'field__label' }, t('admin.doses')),
        h('input', { class: 'input', name: 'standardDosesMg', value: doses, inputmode: 'decimal' })),
      h('div', { class: 'field' },
        h('span', { class: 'field__label' }, t('admin.optionalDoses')),
        h('input', { class: 'input', name: 'optionalMaintenanceMg', value: optional, inputmode: 'decimal', placeholder: t('app.optional') })),
      h('div', { class: 'field' },
        h('span', { class: 'field__label' }, t('admin.escalation')),
        h('textarea', { class: 'input input--area', name: 'escalation', rows: '2' }, d.escalation || '')));
  });

  const save = async () => {
    const payload = drugList().map((d) => {
      const card = cards.find((c) => c.dataset.id === d.id);
      const out = serializeDrug(d);
      const readNums = (el) => String(el.value || '')
        .split(/[,\s]+/).map((x) => Number(x.replace(',', '.'))).filter((n) => Number.isFinite(n) && n > 0);
      if (card) {
        out.standardDosesMg = readNums(card.querySelector('[name="standardDosesMg"]'));
        const opt = card.querySelector('[name="optionalMaintenanceMg"]').value.trim();
        out.optionalMaintenanceMg = opt ? readNums(card.querySelector('[name="optionalMaintenanceMg"]')) : [];
        out.escalation = card.querySelector('[name="escalation"]').value;
      }
      if (!out.standardDosesMg || !out.standardDosesMg.length) out.standardDosesMg = d.standardDosesMg;
      out.catalogVersion = CATALOG_VERSION; // aquesta edició és de la versió actual
      return out;
    });
    try {
      const data = await api.putDrugs(payload);
      setDrugCatalog(data.drugs || payload);
      toast(t('admin.drugsSaved', { n: (data.drugs || payload).length }), { tone: 'ok' });
      update('admin-drugs');
    } catch (err) {
      toast(err.message, { tone: 'error' });
    }
  };

  return sectionCard(
    t('admin.drugs'),
    h('p', { class: 'muted small' }, t('admin.drugsHint')),
    h('div', { class: 'stack' }, cards),
    h('div', { class: 'row' },
      btn(t('nav.patients'), { variant: 'ghost', onClick: () => navigate(patientsPath()) }),
      btn(t('admin.drugsSave'), { variant: 'primary', icon: 'check', onClick: save }))
  );
}

/* ------------------------------------------------------------------ auditoria */
/** Descripció curta d'una entitat per a la llista d'auditoria. */
function describeAudit(entity, row) {
  if (!row) return '';
  if (entity === 'administrations') {
    return `${row.date || ''} · ${row.amount ?? '—'} ${row.unit || ''}${row.mg != null ? ` (≈${row.mg} mg)` : ''}`;
  }
  if (entity === 'plans') {
    return `${row.date || ''} · ${row.amount ?? '—'} ${row.unit || ''}${row.status ? ` · ${row.status}` : ''}`;
  }
  if (entity === 'pens') {
    return `#${row.seq || '?'} · ${row.presentationMg ? `${row.presentationMg} mg` : '—'} · ${row.status || ''}`;
  }
  if (entity === 'costs') {
    return `${row.date || ''} · ${((row.amountCents || 0) / 100).toFixed(2)} €`;
  }
  if (entity === 'health') return `${row.date || ''} · ${row.weightKg != null ? `${row.weightKg} kg` : ''}`;
  if (entity === 'treatment') return row.drugId || '';
  return String(row.id || '');
}

function auditPanel() {
  const patients = (state.patients || []).filter((p) => !p.deletedAt);
  const cap = getCapabilities();
  const listSlot = h('div', { class: 'audit__list' });
  const statusSlot = h('p', { class: 'muted small' }, t('admin.auditEmpty'));

  if (!cap.audit) {
    return sectionCard(t('admin.audit'),
      h('p', { class: 'muted' }, t('admin.auditUnavailable')));
  }

  const sel = h('select', { class: 'input', 'aria-label': t('admin.auditPatient') },
    h('option', { value: '' }, t('admin.auditPatient')),
    patients.map((p) => h('option', { value: p.id },
      `${p.code}${p.name ? ` · ${p.name}` : ''}`)));

  const load = async () => {
    const id = sel.value;
    if (!id) { statusSlot.textContent = t('admin.auditEmpty'); listSlot.replaceChildren(); return; }
    statusSlot.textContent = t('admin.loading');
    try {
      const data = await api.patientAudit(id);
      const entries = data.entries || [];
      if (!entries.length) {
        statusSlot.textContent = t('admin.auditNone');
        listSlot.replaceChildren();
        return;
      }
      statusSlot.textContent = t('admin.auditEntries', { n: entries.length });
      listSlot.replaceChildren(
        h('ul', { class: 'records' },
          entries.map((e) => h('li', { class: 'record audit__row' },
            h('div', { class: 'record__head' },
              h('span', { class: 'record__date' }, String(e.at || '').replace('T', ' ').slice(0, 16)),
              chip(t(`admin.audit_${e.action}`) || e.action, {
                tone: e.action === 'create' ? 'ok' : e.action === 'delete' ? 'danger' : 'muted',
              })),
            h('p', { class: 'muted small' },
              `${e.actor_name || '—'} · ${e.entity || 'patient'} · ${describeAudit(e.entity, e.after || e.before)}`),
            e.before && e.after && e.action === 'update'
              ? h('p', { class: 'muted small audit__diff' },
                  `abans: ${describeAudit(e.entity, e.before)} → després: ${describeAudit(e.entity, e.after)}`)
              : null))));
    } catch (err) {
      statusSlot.textContent = err && err.message ? err.message : t('app.error');
      listSlot.replaceChildren();
    }
  };
  sel.addEventListener('change', load);

  return sectionCard(
    t('admin.audit'),
    h('p', { class: 'muted small' }, t('admin.auditHint')),
    h('div', { class: 'field' },
      h('span', { class: 'field__label' }, t('admin.auditPatient')),
      sel,
      h('span', { class: 'field__hint' }, t('admin.auditHint2'))),
    statusSlot,
    listSlot);
}

/* ------------------------------------------------------------------ vista */
export function renderAdmin() {
  const blocked = guard();
  if (blocked) return h('div', { class: 'view view--admin' }, blocked);

  const tabBar = h('nav', { class: 'tabs', role: 'tablist' },
    [['users', 'admin.users', 'users'], ['tokens', 'admin.tokens', 'clock'], ['drugs', 'admin.drugs', 'pill'], ['audit', 'admin.audit', 'list']].map(([key, label, ic]) =>
      h('button', {
        type: 'button',
        role: 'tab',
        class: `tab ${tab === key ? 'is-active' : ''}`,
        'aria-selected': tab === key ? 'true' : 'false',
        onClick: () => { tab = key; update('admin-tab'); },
      }, icon(ic), h('span', { class: 'tab__label' }, t(label)))));

  const body = h('div', { class: 'tabpanel' },
    tab === 'users' ? usersPanel()
      : tab === 'tokens' ? tokensPanel()
        : tab === 'audit' ? auditPanel()
          : drugsPanel());

  return h('div', { class: 'view view--admin' },
    h('header', { class: 'topbar' },
      iconBtn('chevronLeft', t('nav.patients'), () => navigate(patientsPath()), { variant: 'secondary' }),
      h('div', { class: 'topbar__titles' },
        h('h1', { class: 'topbar__title topbar__title--sm' }, t('admin.title')),
        h('p', { class: 'topbar__sub' }, t('admin.subtitle')))),
    tabBar,
    body);
}
