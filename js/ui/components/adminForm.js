// Alta i edició d'administracions. Cada administració és un registre propi i
// immutable: editar-la és una acció explícita que recalcula els saldos següents.

import { h, btn, selectField, sectionCard, formatNumber } from '../dom.js';
import { openDialog, toast, formError, clearFormError, confirmDialog } from '../modal.js';
import { t } from '../../i18n/index.js';
import { createAdministration } from '../../core/model.js';
import { recomputeBalances, registerAmount, activePen, penBalance, penById, visiblePens, linkPlanToAdmin, unlinkPlanFromAdmin, applyRegisteredDose, propagatePlanChanges, pendingPlans } from '../../core/calc.js';
import {
  clickModeState,
  clicksAvailable,
  dosesForPen,
  getDrug,
  resolveConversion,
  theoreticalDisclaimer,
} from '../../core/drugs.js';
import { persist, update } from '../state.js';
import { todayISO, isValidISO } from '../../core/dates.js';
import { amountLabel, doseAmountLabel } from './summary.js';
import { presetsRow, splitDoseNote } from './presets.js';

function valueEditor({ drug, pen, mode, initial }) {
  const wrap = h('div', { class: 'quickvalue' });
  const presetsSlot = h('div', { class: 'quickvalue__presets' });
  const hint = h('span', { class: 'field__hint' });
  let value = initial;
  let currentPen = pen;

  const refresh = () => {
    wrap.replaceChildren();
    presetsSlot.replaceChildren();
    if (mode === 'clicks') {
      const input = h('input', {
        class: 'input input--big',
        type: 'number',
        inputmode: 'numeric',
        min: '1',
        step: '1',
        value: value ?? '',
        name: 'value',
      });
      input.addEventListener('input', () => { value = input.value; });
      wrap.appendChild(input);
      wrap.appendChild(h('span', { class: 'quickvalue__unit' }, t('admin.clicks')));
      hint.textContent = conversionHint(currentPen, drug, Number(value));
    } else {
      const doses = drug ? dosesForPen(drug) : [];
      if (!doses.length) {
        const input = h('input', { class: 'input input--big', type: 'number', inputmode: 'decimal', min: '0', step: '0.01', value: value ?? '', name: 'value' });
        input.addEventListener('input', () => { value = input.value; });
        wrap.appendChild(input);
        wrap.appendChild(h('span', { class: 'quickvalue__unit' }, 'mg'));
      } else {
        for (const d of doses) {
          const selected = Number(value) === d;
          const chip = h('button', {
            type: 'button',
            class: `dosechip ${selected ? 'is-selected' : ''}`,
            onClick: () => { value = d; refresh(); },
          }, `${formatNumber(d)} mg`);
          wrap.appendChild(chip);
        }
      }
      hint.textContent = mode === 'clicks' ? '' : standardHint(currentPen, drug, value);
      const row = presetsRow({ pen: currentPen, drug, value: Number(value), onPick: (v) => { value = v; refresh(); } });
      if (row) presetsSlot.appendChild(row);
    }
    if (value === undefined || value === null) value = '';

    // Dosi superior a la dosi completa de la ploma: es parteix en injeccions.
    const split = splitDoseNote({ pen: currentPen, drug, mode, value });
    if (split) {
      hint.textContent = hint.textContent ? `${split} · ${hint.textContent}` : split;
      hint.classList.add('warn');
    } else {
      hint.classList.remove('warn');
    }
  };

  refresh();
  return {
    node: wrap,
    presets: presetsSlot,
    hint,
    get value() { return value; },
    set mode(m) { mode = m; refresh(); },
    set pen(p) { currentPen = p; refresh(); },
  };
}

function conversionHint(pen, drug, clicks) {
  const conv = resolveConversion(pen, drug);
  if (!conv || !clicks || clicks <= 0) return conv ? conv.warning || '' : t('pen.conversionMissing');
  const mg = Math.round(clicks * conv.mgPerClick * 1000) / 1000;
  return `≈ ${formatNumber(mg)} mg · ${t('cal.theoretical')}`;
}

function standardHint(pen, drug, value) {
  const conv = resolveConversion(pen, drug);
  if (!conv || !value) return '';
  const clicks = Math.round(Number(value) / conv.mgPerClick);
  return `${formatNumber(value)} mg = ${clicks} ${t('admin.clicks')} · ${t('cal.theoretical')}`;
}

/**
 * Obre el formulari d'administració.
 *  - `admin` presente → edició
 *  - absent → alta nova a `date` amb `quick` com a valor per defecte
 */
export function openAdminForm({ patient, treatment, admin = null, date = null, quick = null } = {}) {
  const drug = getDrug(treatment.drugId);
  const isEdit = Boolean(admin);
  const penId0 = admin ? admin.penId : (quick && quick.penId) || (activePen(treatment) || {}).id;
  let mode = admin ? admin.mode : (quick && quick.mode) || 'standard';
  let initialValue = admin ? (admin.mode === 'clicks' ? admin.amount : admin.value ?? admin.mg) : (quick && quick.value) ?? (drug ? drug.standardDosesMg[0] : '');
  let penId = penId0;

  const errorSlot = h('div', { class: 'form__errors' });
  const dateInput = h('input', { class: 'input', type: 'date', name: 'date', value: admin ? admin.date : date || todayISO() });
  const notesInput = h('textarea', { class: 'input input--area', name: 'notes', rows: '2' }, admin ? admin.notes : '');

  const penSelect = selectField(t('app.pen'), {
    name: 'penId',
    value: penId || '',
    options: visiblePens(treatment).map((p) => ({
      value: p.id,
      label: `${p.presentationMg ? `${formatNumber(p.presentationMg)} mg` : '—'} · ${p.status === 'active' ? t('pen.status.active') : p.status === 'finished' ? t('pen.status.finished') : t('pen.status.discarded')} (${p.startDate})`,
    })),
    onchange: (e) => {
      penId = e.target.value;
      const pen = penById(treatment, penId);
      modeBtns.style.display = clicksAvailable(pen, drug) ? '' : 'none';
      editor.pen = pen;
      editor.mode = mode;
    },
  });

  const modeBtns = h('div', { class: 'segmented', role: 'group', 'aria-label': t('app.mode') });
  const setMode = (m) => {
    mode = m;
    for (const b of modeBtns.children) b.classList.toggle('is-selected', b.dataset.mode === m);
    editor.mode = m;
    refreshDisclaimers();
  };
  for (const m of ['standard', 'clicks']) {
    modeBtns.appendChild(
      h('button', {
        type: 'button',
        class: `segmented__btn ${mode === m ? 'is-selected' : ''}`,
        dataset: { mode: m },
        onClick: () => setMode(m),
      }, m === 'standard' ? t('treatment.modeStandard') : t('treatment.modeClicks'))
    );
  }

  const editor = valueEditor({ drug, pen: penById(treatment, penId), mode, initial: initialValue });
  const disclaimer = h('p', { class: 'disclaimer' });

  function refreshDisclaimers() {
    const pen = penById(treatment, penId);
    const conv = resolveConversion(pen, drug);
    const warn = theoreticalDisclaimer(drug, conv);
    modeBtns.querySelector('[data-mode="clicks"]').disabled = !clicksAvailable(pen, drug);
    if (mode === 'clicks') {
      disclaimer.textContent = warn || t('pen.conversionMissing');
      disclaimer.hidden = !disclaimer.textContent;
    } else {
      disclaimer.textContent = '';
      disclaimer.hidden = true;
    }
  }

  const form = h('form', { class: 'form', novalidate: true },
    sectionCard(null,
      h('div', { class: 'grid2' },
        h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('app.date')), dateInput),
        h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('app.notes')), notesInput)
      ),
      penSelect,
      h('div', { class: 'field' },
        h('span', { class: 'field__label' }, t('app.mode')),
        modeBtns),
      h('div', { class: 'field' },
        h('span', { class: 'field__label' }, t('app.value')),
        editor.node,
        editor.presets,
        editor.hint),
      disclaimer,
      errorSlot
    )
  );

  refreshDisclaimers();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearFormError(form);

    const iso = dateInput.value;
    if (!isValidISO(iso)) return errorSlot.replaceChildren(formError(t('form.date')));
    const pen = penById(treatment, penId);
    if (!pen) return errorSlot.replaceChildren(formError(t('admin.noPen')));

    const computed = registerAmount({ mode, value: Number(editor.value), pen, drug });
    if (!computed.valid) return errorSlot.replaceChildren(formError(t('cal.quickInvalid')));

    if (isEdit) {
      unlinkPlanFromAdmin(treatment, admin.id);
      Object.assign(admin, {
        date: iso,
        penId,
        mode,
        value: mode === 'standard' ? Number(editor.value) : Math.round(Number(editor.value)),
        amount: computed.amount,
        unit: computed.unit,
        mg: computed.mg,
        injections: computed.injections > 1 ? computed.injections : null,
        notes: notesInput.value.trim(),
      });
      linkPlanToAdmin(treatment, admin);
      recomputeBalances(treatment);
      persist(patient);
      update('admin-edited');
      toast(t('admin.recomputed'), { tone: 'ok' });
      close();

      // Modificar una dosi real → opció d'aplicar el canvi a les futures del pla
      const future = pendingPlans(treatment).filter(
        (p) => p.penId === admin.penId && p.date >= admin.date
      );
      if (future.length) {
        const ok = await confirmDialog(t('plan.updateFutureAsk', { n: future.length }), {
          danger: false,
          okLabel: t('plan.scopeFuture'),
        });
        if (ok) {
          const n = propagatePlanChanges(treatment, {
            penId: admin.penId,
            fromDate: admin.date,
            value: admin.value,
            mode: admin.mode,
            amount: admin.amount,
            unit: admin.unit,
            mg: admin.mg,
            shiftDays: 0,
          });
          persist(patient);
          update('plan-propagated');
          toast(t('plan.futureUpdated', { n }), { tone: 'ok' });
        }
      }
      return;
    }

    const adm = createAdministration({
      date: iso,
      penId,
      mode,
      value: mode === 'standard' ? Number(editor.value) : Math.round(Number(editor.value)),
      amount: computed.amount,
      unit: computed.unit,
      mg: computed.mg,
      injections: computed.injections > 1 ? computed.injections : null,
      notes: notesInput.value.trim(),
    });
    treatment.administrations.push(adm);
    const cont = applyRegisteredDose(treatment, adm);
    recomputeBalances(treatment);
    persist(patient);
    update('admin-created');
    toast(withPlanHints(t('cal.quickRegistered', { value: doseAmountLabel(computed), date: iso }), cont), { tone: 'ok' });
    close();
  });

  const { close } = openDialog({
    title: isEdit ? t('admin.new') : t('admin.create'),
    body: form,
    actions: [
      btn(t('app.cancel'), { variant: 'ghost', onClick: () => close() }),
      btn(isEdit ? t('app.save') : t('admin.create'), { variant: 'primary', onClick: () => form.requestSubmit() }),
    ],
  });
}

/** Missatge de registre + el que ha passat amb les propostes futures. */
function withPlanHints(base, cont) {
  const parts = [base];
  if (cont && cont.relevelled) parts.push(t('plan.futureUpdated', { n: cont.relevelled }));
  if (cont && cont.created) parts.push(t('plan.extended', { n: cont.created }));
  return parts.join(' · ');
}

/** Registre ràpid des del calendari (sense diàleg). */
export function createQuickAdmin({ patient, treatment, date, pen, quick }) {
  const drug = getDrug(treatment.drugId);
  const computed = registerAmount({ mode: quick.mode, value: Number(quick.value), pen, drug });
  if (!computed.valid) return { ok: false, reason: 'invalid' };

  const balanceBefore = penBalance(treatment, pen);
  const adm = createAdministration({
    date,
    penId: pen.id,
    mode: quick.mode,
    value: quick.mode === 'standard' ? Number(quick.value) : Math.round(Number(quick.value)),
    amount: computed.amount,
    unit: computed.unit,
    mg: computed.mg,
    injections: computed.injections > 1 ? computed.injections : null,
    balanceBefore,
    balanceAfter: balanceBefore - computed.amount,
  });
  // El registre real mana: re-nivella les propostes futures a la dosi
  // registrada, continua el pla i tanca la proposta d'aquesta data.
  const plansBefore = JSON.parse(JSON.stringify(treatment.plans || []));
  treatment.administrations.push(adm);
  const cont = applyRegisteredDose(treatment, adm);
  recomputeBalances(treatment);
  persist(patient);

  return {
    ok: true,
    admin: adm,
    extended: cont.created.length,
    relevelled: cont.relevelled,
    label: doseAmountLabel(computed),
    undo: () => {
      treatment.plans = plansBefore; // el desfés retorna el pla com estava
      // Tomba (no esborrat físic): el desfés s'ha de poder sincronitzar també
      adm.deletedAt = new Date().toISOString();
      recomputeBalances(treatment);
      persist(patient);
      update('admin-undone');
      return true;
    },
  };
}
