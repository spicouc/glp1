// Pantalla principal: llistat de pacients.

import { h, btn, iconBtn, chip, emptyState } from '../dom.js';
import { openDialog, toast, formError, clearFormError, confirmDialog } from '../modal.js';
import { t } from '../../i18n/index.js';
import { state, loadPatients, persist, removePatient, update } from '../state.js';
import { navigate, patientPath } from '../router.js';
import { openBackupDialog, exportPatient } from '../components/backup.js';
import { syncChip, adminButton, logoutButton, defaultPasswordNotice } from '../components/account.js';
import { createPatient, nextPatientCode } from '../../core/model.js';
import { visibleTreatments } from '../../core/calc.js';

export function patientFormDialog(existing = null) {
  const isNew = !existing;
  const target = existing || createPatient({ code: nextPatientCode(state.patients) });

  const codeInput = h('input', { class: 'input', name: 'code', value: target.code, autocomplete: 'off', required: true });
  const nameInput = h('input', { class: 'input', name: 'name', value: target.name, autocomplete: 'off' });
  const yearInput = h('input', {
    class: 'input', name: 'birthYear', type: 'number', inputmode: 'numeric',
    min: '1900', max: '2200', value: target.birthYear ?? '',
  });
  const notesInput = h('textarea', { class: 'input input--area', name: 'notes', rows: '3' }, target.notes);
  const errorSlot = h('div', { class: 'form__errors' });

  const form = h('form', { class: 'form', novalidate: true },
    h('div', { class: 'field' },
      h('span', { class: 'field__label' }, t('patients.code'), h('span', { class: 'field__req' }, ' *')),
      codeInput),
    h('div', { class: 'field' },
      h('span', { class: 'field__label' }, t('patients.name')),
      nameInput,
      h('span', { class: 'field__hint' }, t('app.optional'))),
    h('div', { class: 'grid2' },
      h('div', { class: 'field' },
        h('span', { class: 'field__label' }, t('patients.birthYear')),
        yearInput,
        h('span', { class: 'field__hint' }, t('app.optional'))),
      h('div', { class: 'field' },
        h('span', { class: 'field__label' }, t('app.notes')),
        notesInput,
        h('span', { class: 'field__hint' }, t('app.optional')))),
    errorSlot
  );

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearFormError(form);
    const code = codeInput.value.trim();
    const birthRaw = yearInput.value.trim();
    const birthYear = birthRaw === '' ? null : Number(birthRaw);

    if (!code) return errorSlot.replaceChildren(formError(t('form.required')));
    if (birthYear !== null && (!Number.isInteger(birthYear) || birthYear < 1900 || birthYear > 2200)) {
      return errorSlot.replaceChildren(formError(t('form.number')));
    }

    Object.assign(target, {
      code,
      name: nameInput.value.trim(),
      birthYear,
      notes: notesInput.value.trim(),
    });
    persist(target);
    close();
    toast(isNew ? t('form.created') : t('form.saved'), { tone: 'ok' });
    update('patient-saved');
  });

  const { close } = openDialog({
    title: isNew ? t('patients.new') : t('patients.edit'),
    body: form,
    actions: [
      btn(t('app.cancel'), { variant: 'ghost', onClick: () => close() }),
      btn(t('app.save'), { variant: 'primary', onClick: () => form.requestSubmit() }),
    ],
  });
}

function patientCard(patient) {
  const archived = Boolean(patient.archived);

  const counts = () => {
    let a = 0;
    let p = 0;
    const trts = visibleTreatments(patient);
    for (const tr of trts) {
      a += (tr.administrations || []).filter((x) => !x.deletedAt).length;
      p += (tr.plans || []).filter((x) => !x.registeredAdminId && !x.deletedAt).length;
    }
    return { n: trts.length, a, p };
  };

  const deleteIt = async () => {
    const c = counts();
    const ok = await confirmDialog(
      t('patients.deleteConfirm', { code: patient.code, n: c.n, a: c.a, p: c.p }),
      { danger: true, okLabel: t('patients.delete'), title: t('patients.delete') }
    );
    if (!ok) return;
    removePatient(patient.id);
    update('patient-deleted');
    toast(t('patients.deleted'), { tone: 'ok' });
  };

  return h(
    'li',
    { class: 'list-card list-card--small', dataset: { search: `${patient.code} ${patient.name}`.toLowerCase(), archived: archived ? '1' : '0' } },
    h('div', { class: 'patient-row' },
      h('div', { class: 'patient-row__id' },
        h('span', { class: 'summary__code' }, patient.code),
        patient.name ? h('span', { class: 'summary__name' }, patient.name) : null),
      archived
        ? chip(t('patients.archive'), { tone: 'muted' })
        : patient.birthYear
          ? h('span', { class: 'patient-row__meta muted small' }, String(patient.birthYear))
          : null),
    h(
      'div',
      { class: 'card__actions' },
      btn(t('patients.open'), { variant: 'primary', icon: 'user', onClick: () => navigate(patientPath(patient.id, 'calendar')) }),
      btn(t('app.edit'), { variant: 'secondary', icon: 'edit', onClick: () => patientFormDialog(patient) }),
      btn(archived ? t('patients.unarchive') : t('patients.archive'), {
        variant: 'ghost',
        icon: 'archive',
        onClick: () => {
          patient.archived = !archived;
          persist(patient);
          update('archive');
        },
      }),
      btn(t('patients.delete'), { variant: 'danger', icon: 'trash', onClick: deleteIt }),
      btn(t('patients.export'), { variant: 'ghost', icon: 'download', onClick: () => exportPatient(patient) })
    )
  );
}

export function renderPatients() {
  loadPatients();
  const patients = state.patients;
  const filters = { query: '', archived: false };

  const list = h('ul', { class: 'cards' });
  const count = h('span', { class: 'muted small' });

  function applyFilters() {
    const q = filters.query.trim().toLowerCase();
    let visible = 0;
    for (const card of list.children) {
      const isArchived = card.dataset.archived === '1';
      const matches = (card.dataset.search || '').includes(q);
      const show = (!isArchived || filters.archived) && matches;
      card.hidden = !show;
      if (show) visible += 1;
    }
    count.textContent = visible ? t('patients.count', { n: visible }) : '';
  }

  const searchInput = h('input', {
    class: 'input',
    type: 'search',
    placeholder: t('patients.search'),
    'aria-label': t('patients.search'),
    onInput: (e) => {
      filters.query = e.target.value;
      applyFilters();
    },
  });

  const hasArchived = patients.some((p) => p.archived);
  const archivedToggle = hasArchived
    ? h('label', { class: 'switch' },
        h('input', {
          type: 'checkbox',
          onChange: (e) => {
            filters.archived = e.target.checked;
            applyFilters();
          },
        }),
        h('span', {}, t('patients.showArchived')))
    : null;

  patients.forEach((p) => list.appendChild(patientCard(p)));

  if (!patients.length) {
    list.appendChild(
      h('li', { class: 'list-card list-card--empty' },
        emptyState(t('patients.empty'), t('patients.emptyHint'),
          btn(t('patients.new'), { variant: 'primary', icon: 'plus', onClick: () => patientFormDialog() })))
    );
  }

  const view = h(
    'div',
    { class: 'view view--patients' },
    h(
      'header',
      { class: 'topbar' },
      h('div', { class: 'topbar__titles' },
        h('h1', { class: 'topbar__title' }, t('nav.patients')),
        h('p', { class: 'topbar__sub' }, t('app.subtitle'))),
      h('div', { class: 'topbar__actions' },
        btn(t('patients.new'), { variant: 'primary', icon: 'plus', onClick: () => patientFormDialog() }),
        iconBtn('upload', t('export.title'), () => openBackupDialog(), { variant: 'secondary' }))
    ),
    defaultPasswordNotice(),
    h('div', { class: 'toolbar' }, searchInput, archivedToggle, count),
    h('div', { class: 'toolbar toolbar--account' }, syncChip(), adminButton(), logoutButton()),
    list,
    patients.length
      ? h('footer', { class: 'view-footer' },
          h('p', { class: 'muted small' }, t('app.subtitle')),
          btn(t('patients.exportAll'), { variant: 'ghost', icon: 'download', onClick: () => openBackupDialog() }))
      : null
  );

  applyFilters();
  return view;
}
