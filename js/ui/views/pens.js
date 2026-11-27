// Plomes: entitat pròpia vinculada al tractament. Mai s'esborren automàticament.

import { h, btn, icon, sectionCard, emptyState, chip, formatNumber, formatEur, progressBar, penNumber } from '../dom.js';
import { openDialog, confirmDialog, toast, formError, clearFormError } from '../modal.js';
import { t, tStatus } from '../../i18n/index.js';
import { createPen, nextPenSeq, resolvePenCapacity } from '../../core/model.js';
import {
  activeTreatment,
  activePen,
  allAdministrations,
  allPlans,
  penExpiry,
  penCost,
  penBalance,
  penUsed,
  penRegisteredUsed,
  penById,
  visiblePens,
  deletePen,
  restorePen,
  penCapacityIn,
  penValueIn,
  penDoseSummary,
  penClicksPerDose,
  registerAmount,
  currentDose,
  recomputePenBalances,
} from '../../core/calc.js';
import {
  getDrug,
  clickModeState,
  clicksAvailable,
  resolveConversion,
  theoreticalDisclaimer,
} from '../../core/drugs.js';
import { persist, update, selectedTreatmentOf } from '../state.js';
import { addDays, todayISO, isValidISO, cmpDates, diffDays, fmtShort } from '../../core/dates.js';
import { unitLabel, amountLabel } from '../components/summary.js';
import { navigate, patientPath } from '../router.js';

function conversionFields(drug, initial = null) {
  if (!drug) return null;
  const tables = Array.isArray(drug.clickTables) ? drug.clickTables : [];
  const manualAllowed =
    drug.clickMode === 'pen-specific' ||
    (drug.clickMode === 'unsupported' && tables.length > 0);
  if (!manualAllowed) return null;

  const table = tables.length ? tables[0] : null;

  const tableBlock = table
    ? h('div', { class: 'notice notice--warn' },
        icon('info'),
        h('div', {},
          h('strong', {}, table.label),
          h('ul', { class: 'kv' },
            table.rows.map((r) =>
              h('li', {}, h('strong', {}, `${formatNumber(r.mg)} mg`), `${r.clicks} ${t('admin.clicks')}`))),
          h('p', { class: 'small' }, table.warning)))
    : null;

  const wrap = h('div', { class: 'stack stack--tight' },
    h('h4', { class: 'subhead' }, t('pen.clickConversion')),
    drug.noClickNote ? h('p', { class: 'muted small' }, drug.noClickNote) : null,
    tableBlock,
    table
      ? h('div', { class: 'row row--end' },
          btn(t('pen.attachTable'), {
            variant: 'secondary', icon: 'plus',
            onClick: () => {
              const set = (name, val) => {
                const el = wrap.querySelector(`[name="${name}"]`);
                if (el) el.value = val;
              };
              set('mgPerClick', String(table.mgPerClick));
              set('sourceType', table.sourceType || 'third-party');
              set('lastReviewed', table.lastReviewed || todayISO());
              set('warning', table.warning || '');
              const verified = wrap.querySelector('[name="verified"]');
              if (verified) verified.checked = Boolean(table.verified);
              toast(t('pen.tableAttached'), { tone: 'ok' });
            },
          }))
      : h('p', { class: 'muted small' }, t('pen.conversionMissingHint')),
    h('div', { class: 'grid3' },
      h('div', { class: 'field' },
        h('span', { class: 'field__label' }, t('pen.conversionPerClick')),
        h('input', { class: 'input', name: 'mgPerClick', type: 'number', step: '0.0001', min: '0', inputmode: 'decimal', value: initial ? initial.mgPerClick ?? '' : '' })),
      h('div', { class: 'field' },
        h('span', { class: 'field__label' }, t('pen.conversionSource')),
        h('select', { class: 'input', name: 'sourceType' },
          ['theoretical', 'third-party', 'official'].map((s) =>
            h('option', { value: s, selected: initial ? initial.sourceType === s : s === 'theoretical' }, s)))),
      h('div', { class: 'field' },
        h('span', { class: 'field__label' }, t('pen.conversionReviewed')),
        h('input', { class: 'input', name: 'lastReviewed', type: 'date', value: initial ? initial.lastReviewed || '' : todayISO() }))),
    h('div', { class: 'field' },
      h('span', { class: 'field__label' }, t('pen.conversionWarning')),
      h('input', { class: 'input', name: 'warning', value: initial ? initial.warning || '' : 'Conversió manual no oficial.' })),
    h('label', { class: 'switch' },
      h('input', { type: 'checkbox', name: 'verified', checked: initial ? Boolean(initial.verified) : false }),
      h('span', {}, t('pen.conversionVerified')))
  );
  return wrap;
}

/** Diàleg d'alta/edició de ploma (exportat perquè el calendari pugui
 *  proposar la creació de la ploma següent amb la data ja triada). */
export function penFormDialog(patient, treatment, opts = {}) {
  return openPenForm(patient, treatment, opts);
}

function openPenForm(patient, treatment, { isNew = false, initial = null, startDate = null } = {}) {
  const drug = getDrug(treatment.drugId);
  const strengths = drug && drug.penStrengthsMg ? drug.penStrengthsMg : null;
  const presSelect = strengths
    ? h('select', { class: 'input', name: 'presentationMg' },
        strengths.map((s) => h('option', { value: s, selected: initial ? Number(initial.presentationMg) === s : false }, `${formatNumber(s)} mg`)))
    : h('input', { class: 'input', name: 'presentationMg', type: 'number', inputmode: 'decimal', step: '0.01', min: '0', value: initial && initial.presentationMg != null ? initial.presentationMg : '' });

  // Capacitat per defecte. Si es coneixen els clics per dosi completa, la
  // capacitat real es desa en Clics (240, 128, 288…) i les dosis es deriven.
  const defaultPres = initial && initial.presentationMg != null
    ? initial.presentationMg
    : (strengths ? strengths[0] : null);
  const plan0 = resolvePenCapacity({
    drug,
    presentationMg: defaultPres,
    capacity: initial ? initial.initialCapacity : (drug ? drug.defaultInitialCapacity : null),
    unit: initial ? initial.capacityUnit : (drug ? drug.capacityUnit : 'doses'),
    clicksPerDose: initial ? initial.clicksPerDose : null,
    dosesPerPen: initial ? initial.dosesPerPen : null,
  });

  const unitSel = h('select', { class: 'input', name: 'capacityUnit' },
    ['clicks', 'doses'].map((u) => h('option', { value: u, selected: u === plan0.unit },
      u === 'clicks' ? t('pen.capacityClicks') : t('pen.capacityDoses'))));

  const capacityInput = h('input', { class: 'input', name: 'initialCapacity', type: 'number', inputmode: 'numeric', min: '1', step: '1', value: plan0.capacity ?? '' });
  const cpcInput = h('input', { class: 'input', name: 'clicksPerDose', type: 'number', inputmode: 'numeric', min: '1', step: '1', 'aria-label': t('pen.clicksPerDose'), value: plan0.clicksPerDose ?? '' });
  const dpnInput = h('input', { class: 'input', name: 'dosesPerPen', type: 'number', inputmode: 'numeric', min: '1', step: '1', 'aria-label': t('pen.dosesPerPen'), value: plan0.dosesPerPen ?? '' });
  const startInput = h('input', { class: 'input', name: 'startDate', type: 'date', value: initial ? initial.startDate : (startDate || todayISO()) });
  const startUsedInput = h('input', { class: 'input', name: 'startUsed', type: 'number', inputmode: 'numeric', min: '0', step: '1', 'aria-label': t('pen.startUsed'), value: initial ? Number(initial.startUsed) || 0 : 0 });
  const notesInput = h('textarea', { class: 'input input--area', name: 'notes', rows: '2' }, initial ? initial.notes : '');
  // Control d'inventari: caducitat impresa, obertura i preu de compra
  const expiryInput = h('input', { class: 'input', name: 'expiryDate', type: 'date', 'aria-label': t('pen.expiry'), value: initial ? initial.expiryDate || '' : '' });
  const openedInput = h('input', { class: 'input', name: 'openedAt', type: 'date', 'aria-label': t('pen.opened'), value: initial ? initial.openedAt || '' : '' });
  const priceInput = h('input', { class: 'input', name: 'priceEur', type: 'number', inputmode: 'decimal', min: '0', step: '0.01', 'aria-label': t('pen.price'), value: initial && initial.priceCents != null ? (Number(initial.priceCents) / 100).toFixed(2) : '' });
  const errorSlot = h('div', { class: 'form__errors' });
  const preview = h('p', { class: 'field__hint pen__preview' });
  const conv = initial ? initial.conversion : null;
  const convBlock = conversionFields(drug, conv);

  const clickUnit = t('admin.clicks');
  const doseUnit = t('pen.capacityDoses');

  /** Vista prèvia en directe: capacitat en clics i dosis, saldo i dosis que hi caben. */
  const updatePreview = () => {
    const pres = presSelect.value === '' ? null : Number(presSelect.value);
    const plan = resolvePenCapacity({
      drug,
      presentationMg: Number.isFinite(pres) ? pres : null,
      capacity: capacityInput.value,
      unit: unitSel.value,
      clicksPerDose: cpcInput.value,
      dosesPerPen: dpnInput.value,
    });
    const cpc = plan.clicksPerDose;
    const unitLabel2 = plan.unit === 'clicks' ? clickUnit : doseUnit;
    const consumed = initial ? penRegisteredUsed(treatment, initial.id) : 0;
    const startUsed = Math.max(0, Number(startUsedInput.value) || 0);
    const saldo = plan.capacity == null ? null : Number(plan.capacity) - startUsed - consumed;
    const parts = [];

    if (plan.capacity != null) {
      parts.push(t('pen.previewCapacity', {
        u: `${formatNumber(plan.capacity)} ${unitLabel2}`,
        d: cpc && plan.unit === 'clicks'
          ? ` = ${formatNumber(plan.capacity / cpc)} ${doseUnit} de ${formatNumber(cpc)} ${clickUnit}`
          : '',
      }));
    }
    if (saldo != null) parts.push(t('pen.previewBalance', { n: `${formatNumber(saldo)} ${unitLabel2}` }));
    if (saldo != null && saldo < 0) {
      parts.push(t('pen.previewNegative'));
      preview.textContent = parts.join(' · ');
      preview.classList.add('warn');
      return;
    }
    preview.classList.remove('warn');

    if (saldo > 0) {
      const dose = currentDose(treatment);
      if (dose && (dose.mode === 'standard' || dose.mode === 'clicks')) {
        const pseudo = {
          ...(initial || {}),
          presentationMg: Number.isFinite(pres) ? pres : null,
          capacityUnit: plan.unit,
          initialCapacity: plan.capacity,
          clicksPerDose: plan.clicksPerDose,
          startUsed,
          conversion: initial ? initial.conversion : null,
        };
        const computed = registerAmount({ mode: dose.mode, value: dose.value, pen: pseudo, drug });
        if (computed.valid && computed.amount > 0) {
          const n = Math.floor(saldo / computed.amount);
          const label = dose.mode === 'standard'
            ? `${formatNumber(Number(dose.value))} mg`
            : `${formatNumber(Number(dose.value))} ${clickUnit}`;
          parts.push(computed.injections > 1
            ? t('pen.previewDoseSplit', { dose: label, n, inj: computed.injections, clicks: formatNumber(computed.amount) })
            : t('pen.previewDose', { dose: label, n }));
        }
      }
    }
    preview.textContent = parts.join(' · ');
  };

  for (const el of [presSelect, unitSel, capacityInput, cpcInput, dpnInput, startUsedInput]) {
    el.addEventListener('input', updatePreview);
    el.addEventListener('change', updatePreview);
  }
  updatePreview();

  const form = h('form', { class: 'form', novalidate: true },
    h('div', { class: 'grid2' },
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('pen.presentation')), presSelect),
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('pen.capacityUnit')), unitSel)),
    h('div', { class: 'grid3' },
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('pen.capacity')), capacityInput),
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('pen.clicksPerDose')), cpcInput),
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('pen.dosesPerPen')), dpnInput)),
    h('div', { class: 'grid2' },
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('pen.start')), startInput),
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('pen.startUsed')), startUsedInput)),
    h('div', { class: 'grid3' },
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('pen.expiry')), expiryInput,
        h('span', { class: 'field__hint' }, t('pen.expiryHint'))),
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('pen.opened')), openedInput,
        h('span', { class: 'field__hint' }, t('pen.openedHint'))),
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('pen.price')), priceInput,
        h('span', { class: 'field__hint' }, t('pen.priceHint')))),
    preview,
    h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('app.notes')), notesInput),
    convBlock,
    errorSlot
  );

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearFormError(form);

    const presRaw = presSelect.value;
    const presentationMg = presRaw === '' ? null : Number(presRaw);
    if (presRaw !== '' && (!Number.isFinite(presentationMg) || presentationMg < 0)) {
      return errorSlot.replaceChildren(formError(t('form.number')));
    }
    const capacityTyped = Number(capacityInput.value);
    if (!Number.isFinite(capacityTyped) || capacityTyped < 1) return errorSlot.replaceChildren(formError(t('form.number')));
    const startDate = startInput.value;
    if (!isValidISO(startDate)) return errorSlot.replaceChildren(formError(t('form.date')));

    const plan = resolvePenCapacity({
      drug,
      presentationMg,
      capacity: capacityTyped,
      unit: unitSel.value,
      clicksPerDose: cpcInput.value,
      dosesPerPen: dpnInput.value,
    });
    if (plan.capacity == null || !Number.isFinite(plan.capacity) || plan.capacity < 1) {
      return errorSlot.replaceChildren(formError(t('form.number')));
    }
    const expiryDate = expiryInput.value || null;
    if (expiryDate && !isValidISO(expiryDate)) return errorSlot.replaceChildren(formError(t('form.date')));
    const openedAt = openedInput.value || null;
    if (openedAt && !isValidISO(openedAt)) return errorSlot.replaceChildren(formError(t('form.date')));
    if (openedAt && expiryDate && cmpDates(openedAt, expiryDate) > 0) {
      return errorSlot.replaceChildren(formError(t('pen.openedAfterExpiry')));
    }
    const priceRaw = priceInput.value === '' ? null : Number(priceInput.value);
    if (priceRaw != null && (!Number.isFinite(priceRaw) || priceRaw < 0)) {
      return errorSlot.replaceChildren(formError(t('form.number')));
    }
    const priceCents = priceRaw == null ? null : Math.round(priceRaw * 100);

    const startUsed = Math.max(0, Number(startUsedInput.value) || 0);
    if (startUsed > plan.capacity) {
      return errorSlot.replaceChildren(formError(t('pen.startUsedTooBig')));
    }
    const consumed = initial ? penRegisteredUsed(treatment, initial.id) : 0;
    if (plan.capacity - startUsed - consumed < 0) {
      return errorSlot.replaceChildren(formError(t('pen.capacityTooSmall', { n: formatNumber(consumed + startUsed) })));
    }

    let conversion = initial ? initial.conversion : null;
    if (convBlock) {
      const mgPerClick = Number(convBlock.querySelector('[name="mgPerClick"]').value);
      const warnVal = convBlock.querySelector('[name="warning"]').value;
      const reviewed = convBlock.querySelector('[name="lastReviewed"]').value;
      const verified = convBlock.querySelector('[name="verified"]').checked;
      const sourceType = convBlock.querySelector('[name="sourceType"]').value;
      if (Number.isFinite(mgPerClick) && mgPerClick > 0) {
        conversion = { mgPerClick, sourceType, verified, warning: warnVal, lastReviewed: reviewed };
      } else if (clickModeState({ presentationMg }, drug) !== 'enabled') {
        conversion = null;
      }
    }

    if (isNew) {
      const pen = createPen({
        presentationMg,
        startDate,
        initialCapacity: plan.capacity,
        capacityUnit: plan.unit,
        clicksPerDose: plan.clicksPerDose,
        dosesPerPen: plan.dosesPerPen,
        startUsed,
        conversion,
        expiryDate,
        openedAt,
        priceCents,
        notes: notesInput.value.trim(),
        seq: nextPenSeq(treatment),
      });
      // L'anterior ploma activa queda registrada a l'històric.
      for (const p of treatment.pens) {
        if (p.status === 'active') {
          p.status = 'finished';
          p.endDate = cmpDates(startDate, p.endDate || startDate) <= 0 ? addDays(startDate, -1) : p.endDate;
        }
      }
      treatment.pens.push(pen);
      persist(patient);
      update('pen-created');
      toast(t('form.created'), { tone: 'ok' });
    } else {
      Object.assign(initial, {
        presentationMg,
        initialCapacity: plan.capacity,
        capacityUnit: plan.unit,
        clicksPerDose: plan.clicksPerDose,
        dosesPerPen: plan.dosesPerPen,
        startUsed,
        startDate,
        conversion,
        expiryDate,
        openedAt,
        priceCents,
        notes: notesInput.value.trim(),
      });
      // Els snapshots "abans/després" depenen de la capacitat i del consum prèvi.
      recomputePenBalances(treatment, initial);
      persist(patient);
      update('pen-updated');
      toast(t('form.saved'), { tone: 'ok' });
    }
    close();
  });

  const { close } = openDialog({
    title: isNew ? t('pen.new') : t('pen.edit'),
    body: form,
    actions: [
      btn(t('app.cancel'), { variant: 'ghost', onClick: () => close() }),
      btn(t('app.save'), { variant: 'primary', onClick: () => form.requestSubmit() }),
    ],
  });
}

/**
 * Diàleg d'esborrat de ploma.
 *
 *  - Per defecte es MOUEN les administracions i les propostes a una altra
 *    ploma (l'historial es conserva).
 *  - Opcionalment s'esborren també les dades, amb confirmació explícita.
 *  - En tots dos casos la ploma queda com a tomba (es pot restaurar) i el seu
 *    número `seq` es conserva: la numeració de la resta no es mou.
 */
export function penDeleteDialog(patient, treatment, pen) {
  const n = penNumber(treatment.pens, pen.id);
  const others = visiblePens(treatment).filter((p) => p.id !== pen.id);
  const admins = allAdministrations(treatment).filter((a) => a.penId === pen.id);
  const plans = allPlans(treatment).filter((pl) => pl.penId === pen.id);

  const finish = (res, moved = false, target = null) => {
    if (!res || !res.ok) {
      toast(t('pen.deleteFail'), { tone: 'error' });
      return false;
    }
    persist(patient);
    update('pen-deleted');
    toast(moved
      ? t('pen.deleteDoneMove', { n: `#${n}`, a: res.moved, p: res.plansMoved, t: `#${target}` })
      : t('pen.deleteDone', { n: `#${n}`, a: res.removed, p: res.plansRemoved }),
    { tone: 'ok' });
    return true;
  };

  const doRemove = async () => {
    if (admins.length || plans.length) {
      const ok = await confirmDialog(
        t('pen.deleteConfirmRemove', { n: `#${n}`, a: admins.length, p: plans.length }),
        { danger: true, okLabel: t('pen.deleteRemove') }
      );
      if (!ok) return;
    }
    if (finish(deletePen(treatment, pen, { removeData: true }))) close();
  };

  const doMove = () => {
    const targetId = targetSel ? targetSel.value : null;
    if (!targetId) return;
    const res = deletePen(treatment, pen, { targetPenId: targetId });
    if (finish(res, true, penNumber(treatment.pens, targetId))) close();
  };

  // La ploma de destí per defecte: la més propera en el temps.
  const sorted = others.slice().sort(
    (a, b) => Math.abs(diffDays(a.startDate, pen.startDate)) - Math.abs(diffDays(b.startDate, pen.startDate))
  );
  const targetSel = sorted.length
    ? h('select', { class: 'input', name: 'target', 'aria-label': t('pen.deleteTarget') },
        sorted.map((pl) => h('option', { value: pl.id },
          `#${penNumber(treatment.pens, pl.id)}` +
          (pl.presentationMg ? ` · ${formatNumber(pl.presentationMg)} mg` : '') +
          ` · ${pl.startDate}${pl.status === 'active' ? ' · ' + tStatus('pen', 'active') : ''}`)))
    : null;

  const body = h('div', { class: 'stack stack--tight' },
    h('p', { class: 'dialog__text' },
      t('pen.deleteSummary', { n: `#${n}`, a: admins.length, p: plans.length })),
    others.length
      ? h('div', { class: 'field' },
          h('span', { class: 'field__label' }, t('pen.deleteTarget')),
          targetSel,
          h('span', { class: 'field__hint' }, t('pen.deleteMoveHint', { n: `#${n}` })))
      : h('p', { class: 'muted small' }, t('pen.deleteNoTarget')),
    h('p', { class: 'muted small' }, t('pen.deleteHint'))
  );

  const { close } = openDialog({
    title: t('pen.deleteTitle', { n: `#${n}` }),
    body,
    actions: [
      btn(t('app.cancel'), { variant: 'ghost', onClick: () => close() }),
      others.length ? btn(t('pen.deleteMove'), { variant: 'primary', icon: 'edit', onClick: doMove }) : null,
      btn(t('pen.deleteRemove'), { variant: 'danger', icon: 'trash', onClick: doRemove }),
    ].filter(Boolean),
  });
}

/**
 * Línies derivades de la ploma (estil count.click): capacitat i saldo en
 * clics i en dosis, mg per clic, quantes dosis completes queden i quantes
 * hi caben a la dosi actual.
 */
function penMetaLines(treatment, pen) {
  const drug = getDrug(treatment.drugId);
  const cpc = penClicksPerDose(pen);
  const lines = [];
  const clickUnit = t('admin.clicks');
  const doseUnit = t('pen.capacityDoses');

  if (cpc) {
    const capClicks = penCapacityIn(pen, 'clicks');
    const capDoses = penValueIn(pen, Number(pen.initialCapacity || 0), 'doses');
    if (capClicks != null && capDoses != null) {
      lines.push(t('pen.metaCapacity', {
        c: `${formatNumber(capClicks)} ${clickUnit}`,
        d: `${formatNumber(capDoses)} ${doseUnit} de ${formatNumber(cpc)} ${clickUnit}`,
      }));
      if (pen.presentationMg) {
        lines.push(t('pen.metaPerClick', { v: formatNumber(Number(pen.presentationMg) / cpc) }));
      }
      const balClicks = penValueIn(pen, penBalance(treatment, pen), 'clicks');
      const balDoses = penValueIn(pen, penBalance(treatment, pen), 'doses');
      if (balClicks != null && balDoses != null) {
        lines.push(t('pen.metaBalance', {
          b: `${formatNumber(balClicks)} ${clickUnit}`,
          d: `${formatNumber(balDoses)} ${doseUnit}`,
        }));
      }
      const sum = penDoseSummary(treatment, pen);
      if (sum) {
        lines.push(sum.remainder > 0
          ? t('pen.metaRemaining', { full: sum.full, rest: formatNumber(sum.remainder) })
          : t('pen.metaRemainingExact', { full: sum.full }));
      }
    }
  }

  if (Number(pen.startUsed) > 0) {
    lines.push(t('pen.startUsedNote', { n: `${formatNumber(Number(pen.startUsed))} ${pen.capacityUnit === 'clicks' ? clickUnit : doseUnit}` }));
  }

  const dose = currentDose(treatment);
  if (dose && (dose.mode === 'standard' || dose.mode === 'clicks')) {
    const computed = registerAmount({ mode: dose.mode, value: dose.value, pen, drug });
    const saldo = penBalance(treatment, pen);
    if (computed.valid && computed.amount > 0 && saldo > 0) {
      const n = Math.floor(saldo / computed.amount);
      const label = dose.mode === 'standard'
        ? `${formatNumber(Number(dose.value))} mg`
        : `${formatNumber(Number(dose.value))} ${clickUnit}`;
      lines.push(computed.injections > 1
        ? t('pen.metaAtDoseSplit', { dose: label, n, inj: computed.injections, clicks: formatNumber(computed.amount) })
        : t('pen.metaAtDose', { dose: label, n }));
    }
  }

  // --- inventari: caducitat, obertura i cost --------------------------
  const exp = penExpiry(treatment, pen);
  if (exp) {
    if (exp.effective) {
      lines.push(exp.expired
        ? t('pen.metaExpired', { date: fmtShort(exp.effective) })
        : t('pen.metaExpiry', { date: fmtShort(exp.effective), n: exp.daysLeft }));
    } else {
      lines.push(t('pen.metaNoExpiry'));
    }
    if (exp.openedAt) {
      lines.push(t('pen.metaOpened', {
        date: fmtShort(exp.openedAt),
        until: exp.openUntil ? fmtShort(exp.openUntil) : t('pen.openUntilUnknown'),
      }));
    }
  }
  const cost = penCost(pen);
  if (cost) {
    lines.push(cost.perDoseCents != null
      ? t('pen.metaCostPerDose', {
          total: formatEur(cost.cents),
          per: formatEur(cost.perDoseCents),
          n: cost.doses,
        })
      : t('pen.metaCost', { total: formatEur(cost.cents) }));
  }

  if (!lines.length) return [];
  return [h('ul', { class: 'kv small pen__meta' }, lines.map((l) => h('li', {}, l)))];
}

function penCard(patient, treatment, pen, { active = false } = {}) {
  const drug = getDrug(treatment.drugId);
  const balance = penBalance(treatment, pen);
  const used = penUsed(treatment, pen.id);
  const capacity = Number(pen.initialCapacity || 0);
  const conv = resolveConversion(pen, drug);
  const warn = theoreticalDisclaimer(drug, conv);
  const st = clickModeState(pen, drug);

  const actions = h('div', { class: 'card__actions' },
    btn(t('app.edit'), { variant: 'secondary', icon: 'edit', onClick: () => penFormDialog(patient, treatment, { initial: pen }) }));

  if (active) {
    actions.appendChild(btn(t('pen.startNew'), {
      variant: 'accent', icon: 'plus',
      onClick: () => penFormDialog(patient, treatment, { isNew: true }),
    }));
  } else {
    actions.appendChild(btn(pen.status === 'discarded' ? t('pen.status.active') : t('pen.status.discarded'), {
      variant: 'ghost',
      onClick: async () => {
        const target = pen.status === 'discarded' ? 'active' : 'discarded';
        const ok = await confirmDialog(
          target === 'discarded' ? t('app.deleteConfirm') : `${t('pen.startNewHint')}`,
          { danger: target === 'discarded', okLabel: tStatus('pen', target) }
        );
        if (!ok) return;
        pen.status = target;
        persist(patient);
        update('pen-status');
      },
    }));
  }

  // Esborrar està disponible a qualsevol ploma (també l'activa).
  actions.appendChild(btn(t('pen.delete'), {
    variant: 'ghost',
    icon: 'trash',
    onClick: () => penDeleteDialog(patient, treatment, pen),
  }));

  return sectionCard(
    null,
    h('div', { class: `pen ${active ? 'pen--active' : ''}` },
      h('div', { class: 'pen__head' },
        h('div', {},
          h('h3', { class: 'pen__title' },
            `${t('app.pen')}`,
            h('span', { class: 'pen__n' }, ` #${penNumber(treatment.pens, pen.id)}`)),
          h('p', { class: 'pen__sub' }, `${drug ? drug.label : treatment.drugId} · ${pen.presentationMg ? `${formatNumber(pen.presentationMg)} mg` : '—'} · ${pen.startDate}`)),
        h('div', { class: 'pen__badges' },
          chip(tStatus('pen', pen.status), { tone: pen.status === 'active' ? 'ok' : 'muted' }),
          (() => {
            const e = penExpiry(treatment, pen);
            if (!e || !e.effective) return null;
            if (e.expired) return chip(t('pen.expired'), { tone: 'danger' });
            if (e.expiringSoon) return chip(t('pen.expiringSoon'), { tone: 'warn' });
            return null;
          })())),
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('span', { class: 'stat__label' }, t('pen.capacity')), h('span', { class: 'stat__value' }, `${formatNumber(capacity)} ${unitLabel(pen.capacityUnit)}`)),
        h('div', { class: 'stat' }, h('span', { class: 'stat__label' }, t('pen.used')), h('span', { class: 'stat__value' }, `${formatNumber(used)} ${unitLabel(pen.capacityUnit)}`)),
        h('div', { class: 'stat stat--real' }, h('span', { class: 'stat__label' }, t('pen.balance')), h('span', { class: 'stat__value' }, `${formatNumber(balance)} ${unitLabel(pen.capacityUnit)}`))),
      progressBar(balance, capacity),
      ...penMetaLines(treatment, pen),
      conv
        ? h('p', { class: 'muted small' },
            `${t('pen.clickConversion')}: ${formatNumber(conv.mgPerClick)} mg/clic · ${conv.sourceType}${conv.verified ? ' ✓' : ''}`,
            warn ? h('span', { class: 'disclaimer-inline' }, ` ${warn}`) : null)
        : !clicksAvailable(pen, drug)
          ? h('p', { class: 'muted small' }, drug && drug.noClickNote ? drug.noClickNote : t('pen.conversionMissing'))
          : null,
      pen.notes ? h('p', { class: 'muted' }, pen.notes) : null,
      actions)
  );
}

// L'estat obert de la paperera es desa aquí: els re-renderitzats de fons
// (sincronització automàtica) no han de tornar-la a plegar mentre s'està mirant.
const openTrash = new Set();

/** Fitxa d'una ploma esborrada (tomba): es pot restaurar. */
function penDeletedCard(patient, treatment, pen) {
  const drug = getDrug(treatment.drugId);
  const n = penNumber(treatment.pens, pen.id);
  return sectionCard(
    null,
    h('div', { class: 'pen pen--deleted' },
      h('div', { class: 'pen__head' },
        h('div', {},
          h('h3', { class: 'pen__title' },
            t('app.pen'), h('span', { class: 'pen__n' }, ` #${n}`)),
          h('p', { class: 'pen__sub' },
            `${drug ? drug.label : treatment.drugId}` +
            `${pen.presentationMg ? ` · ${formatNumber(pen.presentationMg)} mg` : ''}` +
            ` · ${pen.startDate}${pen.deletedAt ? ` → ${pen.deletedAt.slice(0, 10)}` : ''}`)),
        chip(t('pen.status.deleted'), { tone: 'muted' })),
      pen.notes ? h('p', { class: 'muted small' }, pen.notes) : null,
      h('div', { class: 'card__actions' },
        btn(t('pen.restore'), {
          variant: 'secondary',
          icon: 'edit',
          onClick: () => {
            const res = restorePen(treatment, pen);
            if (!res.ok) { toast(t('pen.restoreFail'), { tone: 'error' }); return; }
            persist(patient);
            update('pen-restored');
            toast(t('pen.restoreDone', { n: `#${n}`, status: tStatus('pen', res.status) }), { tone: 'ok' });
          },
        })))
  );
}

export function renderPens(patient) {
  const treatment = selectedTreatmentOf(patient);

  if (!treatment) {
    return emptyState(
      t('treatment.empty'),
      t('treatment.emptyHint'),
      btn(t('treatment.new'), { variant: 'primary', icon: 'plus', onClick: () => navigate(patientPath(patient.id, 'treatment')) })
    );
  }

  const pens = visiblePens(treatment).slice().sort((a, b) => cmpDates(b.startDate, a.startDate));
  const active = activePen(treatment);
  const others = pens.filter((p) => p.id !== (active || {}).id);
  const deleted = (treatment.pens || [])
    .filter((p) => p.status === 'deleted')
    .sort((a, b) => cmpDates(b.startDate, a.startDate));

  return h(
    'div',
    { class: 'view view--pens' },
    h('div', { class: 'section-head' },
      h('h2', { class: 'section-head__title' }, t('nav.pens')),
      btn(t('pen.new'), { variant: 'primary', icon: 'plus', onClick: () => penFormDialog(patient, treatment, { isNew: true }) })),
    active
      ? penCard(patient, treatment, active, { active: true })
      : emptyState(t('pen.empty'), t('pen.emptyHint'),
          btn(t('pen.startNew'), { variant: 'primary', icon: 'plus', onClick: () => penFormDialog(patient, treatment, { isNew: true }) })),
    active ? h('p', { class: 'muted small' }, t('pen.startNewHint')) : null,
    others.length
      ? h('div', {},
          h('h3', { class: 'subhead' }, t('pen.previous')),
          h('div', { class: 'stack' }, others.map((p) => penCard(patient, treatment, p))))
      : null,
    deleted.length
      ? h('details', {
          class: 'penlist',
          open: openTrash.has(treatment.id),
          onToggle: (e) => {
            const el = e.currentTarget || e.target;
            if (el.open) openTrash.add(treatment.id);
            else openTrash.delete(treatment.id);
          },
        },
        h('summary', { class: 'penlist__summary' },
          t('pen.deletedList', { n: deleted.length })),
        h('div', { class: 'stack' }, deleted.map((p) => penDeletedCard(patient, treatment, p))))
      : null,
    treatment.pens.length && active
      ? h('div', { class: 'row' },
          btn(t('nav.calendar'), { variant: 'accent', icon: 'syringe', onClick: () => navigate(patientPath(patient.id, 'calendar')) }))
      : null
  );
}
