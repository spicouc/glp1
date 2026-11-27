// Fitxa del pacient: capçalera amb el resum i pestanyes.

import { h, btn, iconBtn, icon, emptyState } from '../dom.js';
import { t, tStatus } from '../../i18n/index.js';
import { findPatient, promptOnce, selectedTreatmentOf, setSelectedTreatment, update } from '../state.js';
import { navigate, patientPath, patientsPath, TABS } from '../router.js';
import { summaryBlocks } from '../components/summary.js';
import { activeTreatment, visibleTreatments } from '../../core/calc.js';
import { fmtShort } from '../../core/dates.js';
import { getDrug } from '../../core/drugs.js';
import { openBackupDialog } from '../components/backup.js';
import { syncChip } from '../components/account.js';
import { patientFormDialog } from './patients.js';
import { renderCalendar } from './calendar.js';
import { renderTreatments, treatmentFormDialog } from './treatment.js';
import { renderPens } from './pens.js';
import { renderHealth } from './health.js';
import { renderHistory } from './history.js';

const TAB_LABELS = {
  calendar: ['nav.calendar', 'calendar'],
  treatment: ['nav.treatment', 'pill'],
  pens: ['nav.pens', 'syringe'],
  health: ['nav.health', 'scale'],
  history: ['nav.history', 'list'],
};

const TAB_RENDER = {
  calendar: renderCalendar,
  treatment: renderTreatments,
  pens: renderPens,
  health: renderHealth,
  history: renderHistory,
};

/**
 * Selector GLOBAL de tractament (req. 1): permet veure qualsevol tractament del
 * pacient a totes les pestanyes. Per defecte, l'actiu; canvia de tractament
 * conserva l'historial de l'anterior (mai el toca).
 */
function treatmentSelect(patient) {
  const list = visibleTreatments(patient)
    .slice()
    .sort((a, b) => String(b.startDate).localeCompare(String(a.startDate)));
  if (list.length < 2) return null;

  const current = selectedTreatmentOf(patient) || list[0];
  const label = (tr) => {
    const drug = getDrug(tr.drugId);
    const range = tr.endDate
      ? `${fmtShort(tr.startDate)} → ${fmtShort(tr.endDate)}`
      : `${fmtShort(tr.startDate)} → ${tStatus('treatment', tr.status)}`;
    return `${drug ? drug.label : tr.drugId} · ${range}`;
  };

  const sel = h('select', {
    class: 'input treatment-select',
    'aria-label': t('patient.treatmentSelect'),
  }, list.map((tr) => h('option', { value: tr.id, selected: tr.id === current.id }, label(tr))));

  sel.addEventListener('change', () => {
    setSelectedTreatment(patient.id, sel.value);
    update('treatment-selected');
  });

  return h('div', { class: 'treatment-select__wrap' },
    h('span', { class: 'field__label' }, t('patient.treatmentSelect')),
    sel);
}

function notFound() {
  return h('div', { class: 'view' },
    emptyState(t('patient.notFound'), null,
      btn(t('nav.patients'), { variant: 'primary', onClick: () => navigate(patientsPath()) })));
}

export function renderPatient(params) {
  const patient = findPatient(params.id);
  if (!patient) return notFound();

  const tab = TABS.includes(params.tab) ? params.tab : 'calendar';
  const { node, summary } = summaryBlocks(patient, { variant: 'full' });

  const tabBar = h('nav', { class: 'tabs', role: 'tablist' },
    TABS.map((key) => {
      const [label, ic] = TAB_LABELS[key];
      return h('button', {
        type: 'button',
        role: 'tab',
        class: `tab ${tab === key ? 'is-active' : ''}`,
        'aria-selected': tab === key ? 'true' : 'false',
        onClick: () => navigate(patientPath(patient.id, key)),
      }, icon(ic), h('span', { class: 'tab__label' }, t(label)));
    }));

  const content = h('div', { class: 'tabpanel', role: 'tabpanel' });

  const header = h(
    'header',
    { class: 'topbar topbar--patient' },
    iconBtn('chevronLeft', t('nav.patients'), () => navigate(patientsPath()), { variant: 'secondary' }),
    h('div', { class: 'topbar__titles' },
      h('h1', { class: 'topbar__title topbar__title--sm' }, patient.code, patient.name ? ` · ${patient.name}` : '')),
    h('div', { class: 'topbar__actions' },
      syncChip({ compact: true }),
      btn(t('app.edit'), { variant: 'ghost', icon: 'edit', onClick: () => patientFormDialog(patient) }),
      iconBtn('download', t('export.title'), () => openBackupDialog({ patient }), { variant: 'secondary' }))
  );

  const cta = summary.treatment
    ? btn(t('patient.registerDose'), {
        variant: 'accent', icon: 'syringe', block: true, cls: 'cta-dose',
        onClick: () => navigate(patientPath(patient.id, 'calendar')),
      })
    : btn(t('treatment.new'), {
        variant: 'accent', icon: 'plus', block: true, cls: 'cta-dose',
        onClick: () => navigate(patientPath(patient.id, 'treatment')),
      });

  const view = h(
    'div',
    { class: 'view view--patient' },
    header,
    node,
    cta,
    h('hr', { class: 'rule' }),
    treatmentSelect(patient) || null,
    tabBar,
    content
  );

  const renderer = TAB_RENDER[tab] || renderCalendar;
  content.appendChild(renderer(patient));

  // Sense tractament actiu: la primera vegada es demana de seguida quin
  // fàrmac, quina dosi i quina ploma (només un cop; després, botó normal).
  if (!activeTreatment(patient)) {
    promptOnce(`treatment:${patient.id}`, () => {
      setTimeout(() => treatmentFormDialog(patient), 0);
    });
  }

  return view;
}
