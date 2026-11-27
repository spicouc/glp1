// Fitxa del dia: administracions registrades + pauta prevista per a aquesta data.

import { h, btn, chip, sectionCard, formatNumber, penNumber, penColorClass } from '../dom.js';
import { openDialog, confirmDialog, toast } from '../modal.js';
import { t } from '../../i18n/index.js';
import { fmtMedium, fmtShort, addDays } from '../../core/dates.js';
import { penById, recomputeBalances, treatmentDrug, unlinkPlanFromAdmin, penBalance, tombstoneAdministration, tombstonePlan, allAdministrations, plannedEntries, reopenPlan } from '../../core/calc.js';
import { resolveConversion, theoreticalDisclaimer } from '../../core/drugs.js';
import { persist, update } from '../state.js';
import { openAdminForm } from './adminForm.js';
import { planEntryDialog, planStatusDialog, registerPlanEntry } from './planForm.js';
import { amountLabel, unitLabel, equivalenceLine } from './summary.js';

function adminRow({ patient, treatment, admin, onDeleted }) {
  const pen = penById(treatment, admin.penId);
  const drug = treatmentDrug(treatment);
  const conv = pen ? resolveConversion(pen, drug) : null;
  const warn = theoreticalDisclaimer(drug, conv);

  const equiv = admin.mg != null
    ? h('p', { class: 'detail__equiv' },
        h('span', { class: 'pill pill--derived' }, t('k.derived')),
        h('span', {}, `${formatNumber(admin.mg)} mg`),
        warn ? h('span', { class: 'disclaimer-inline' }, warn) : null)
    : null;

  return sectionCard(
    null,
    h('div', { class: 'detail' },
      h('div', { class: 'detail__main' },
        h('span', { class: 'pill pill--real' }, t('k.real')),
        h('strong', { class: 'detail__amount' }, amountLabel(admin.amount, admin.unit)),
        admin.injections > 1
          ? chip(t('cal.splitShort', { n: admin.injections }), {
              tone: 'warn',
              title: t('cal.splitDose', { n: admin.injections, clicks: formatNumber(admin.amount) }),
            })
          : null,
        h('span', { class: 'detail__pen' },
          `${t('app.pen')}: ${pen && pen.presentationMg ? `${formatNumber(pen.presentationMg)} mg` : '—'} · ${pen ? pen.startDate : ''}`)),
      equiv,
      equivalenceLine(pen, drug, { mg: admin.mg, clicks: admin.amount != null ? admin.amount : null }),
      h('dl', { class: 'detail__balances' },
        h('dt', {}, t('cal.before')),
        h('dd', {}, admin.balanceBefore != null ? `${formatNumber(admin.balanceBefore)} ${unitLabel(admin.unit)}` : '—'),
        h('dt', {}, t('cal.administeredCount')),
        h('dd', {}, `− ${formatNumber(admin.amount)} ${unitLabel(admin.unit)}`),
        h('dt', {}, t('cal.after')),
        h('dd', {}, admin.balanceAfter != null ? `${formatNumber(admin.balanceAfter)} ${unitLabel(admin.unit)}` : '—')),
      admin.notes ? h('p', { class: 'detail__notes' }, admin.notes) : null,
      h('div', { class: 'row' },
        btn(t('app.edit'), {
          variant: 'secondary', icon: 'edit',
          onClick: () => { close(); openAdminForm({ patient, treatment, admin }); },
        }),
        btn(t('app.delete'), {
          variant: 'danger', icon: 'trash',
          onClick: async () => {
            const ok = await confirmDialog(t('admin.deleteConfirm'), { okLabel: t('app.delete') });
            if (!ok) return;
            unlinkPlanFromAdmin(treatment, admin.id);
            tombstoneAdministration(treatment, admin.id);
            recomputeBalances(treatment);
            persist(patient);
            update('admin-deleted');
            close();
            toast(t('form.deleted'), { tone: 'ok' });
            if (onDeleted) onDeleted();
          },
        }))
    )
  );
}

export function openDaySheet({ patient, treatment, date, projection = null, quick = null, plans = [] }) {
  const body = h('div', { class: 'daysheet' });
  let closed = false;

  /**
   * Fila d'una dosi prevista (entrada de pla), amb el seu ESTAT:
   * prevista · ajornada · omesa · cancel·lada. Les accions depenen de l'estat:
   * una dosi omesa/cancel·lada es pot tornar a posar al pla.
   */
  const planRow = (entry) => {
    const pen = penById(treatment, entry.penId);
    const n = penNumber(treatment.pens, entry.penId);
    const status = entry.status || 'planned';
    const inactive = status === 'omitted' || status === 'cancelled';
    const postponed = status === 'postponed';
    // Ometre/cancel·lar val per a qualsevol proposta activa (també les
    // ajornades); "Ajorna" només té sentit per a una proposta normal (per
    // moure una ajornada, ja hi ha "Edita"); i "Torna al pla" desfés l'estat.
    const canPostpone = !inactive && !postponed;
    const canOmitCancel = !inactive;
    const tone = { planned: 'warn', postponed: 'warn', omitted: 'muted', cancelled: 'muted' }[status] || 'muted';

    const statusLabel = status === 'planned'
      ? t('plan.proposalTag')
      : t(`plan.status.${status}`);

    const meta = [];
    if (entry.originalDate) meta.push(t('plan.originalDate', { date: fmtShort(entry.originalDate) }));
    if (entry.reason) meta.push(`${t('plan.reason')}: ${entry.reason}`);
    if (postponed && entry.movedTo) meta.push(t('plan.statusChanged', {
      status: t('plan.status.postponed'), date: fmtShort(entry.movedTo),
    }));

    const registerBtn = btn(t('plan.register'), {
      variant: 'primary', icon: 'check',
      onClick: () => {
        const res = registerPlanEntry({ patient, treatment, entry });
        if (!res) return;
        update('plan-registered');
        close();
        toast(res.extended
          ? `${t('plan.registered')} ${t('plan.extended', { n: res.extended })}`
          : t('plan.registered'), { tone: 'ok' });
      },
    });

    const STATUS_ICON = { postpone: 'calendar', omit: 'minus', cancelPlan: 'close' };
    const statusAction = (kind) => btn(t(`plan.${kind}`), {
      variant: 'ghost', icon: STATUS_ICON[kind] || 'minus',
      onClick: () => { close(); planStatusDialog({ patient, treatment, entry, kind }); },
    });

    const reopenBtn = btn(t('plan.reopen'), {
      variant: 'secondary', icon: 'check',
      onClick: () => {
        reopenPlan(treatment, entry.id);
        persist(patient);
        update('plan-reopened');
        close();
        toast(t('plan.reopened'), { tone: 'ok' });
      },
    });

    const deleteBtn = btn(t('plan.delete'), {
      variant: 'ghost', icon: 'trash',
      onClick: async () => {
        const ok = await confirmDialog(t('plan.deleteConfirm'), { okLabel: t('plan.delete') });
        if (!ok) return;
        tombstonePlan(treatment, entry.id);
        persist(patient);
        update('plan-deleted');
        close();
        toast(t('form.deleted'), { tone: 'ok' });
      },
    });

    return sectionCard(
      null,
      h('div', { class: 'detail' },
        h('div', { class: 'detail__main' },
          h('span', { class: 'pill pill--projected' }, t('plan.entry')),
          chip(statusLabel, { tone }),
          h('strong', { class: 'detail__amount detail__amount--plan' }, amountLabel(entry.amount, entry.unit)),
          h('span', { class: 'detail__pen' },
            `#${n} · ${pen && pen.presentationMg ? `${formatNumber(pen.presentationMg)} mg` : '—'}`)),
        entry.mg != null
          ? h('p', { class: 'detail__equiv' },
              h('span', { class: 'pill pill--derived' }, t('k.derived')),
              h('span', {}, `${formatNumber(entry.mg)} mg`))
          : null,
        meta.length
          ? h('p', { class: 'muted small detail__meta' }, meta.join(' · '))
          : null,
        h('div', { class: 'row' },
          inactive ? reopenBtn : registerBtn,
          inactive ? deleteBtn : btn(t('plan.edit'), {
            variant: 'secondary', icon: 'edit',
            onClick: () => { close(); planEntryDialog({ patient, treatment, entry }); },
          }),
          canPostpone ? statusAction('postpone') : null,
          canOmitCancel ? statusAction('omit') : null,
          canOmitCancel ? statusAction('cancelPlan') : null,
          postponed ? reopenBtn : null,
          inactive ? null : deleteBtn)
      )
    );
  };

  function render() {
    const admins = allAdministrations(treatment)
      .filter((a) => a.date === date)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

    const pendingPlans = plannedEntries(treatment).filter((p) => p.date === date);

    body.replaceChildren();

    if (admins.length) {
      body.appendChild(
        h('ul', { class: 'daysheet__list' },
          admins.map((a) =>
            h('li', {}, adminRow({ patient, treatment, admin: a, onDeleted: render }))
          ))
      );
    }

    if (pendingPlans.length) {
      const planList = h('ul', { class: 'daysheet__list' },
        pendingPlans.map((p) => h('li', {}, planRow(p))));
      body.appendChild(h('div', { class: 'daysheet__plans' }, planList));
    }

    if (!admins.length && !pendingPlans.length) {
      body.appendChild(h('p', { class: 'muted' }, t('cal.noAdmins')));
    }

    if (projection) {
      body.appendChild(
        h('div', { class: 'projection' },
          h('h3', { class: 'subhead' }, t('cal.projectionFor')),
          h('div', { class: 'projection__row' },
            h('span', { class: 'pill pill--projected' }, t('k.projected')),
            h('strong', {}, amountLabel(projection.amount, projection.unit)),
            projection.mg != null ? h('span', {}, `≈ ${formatNumber(projection.mg)} mg`) : null),
          projection.balanceAfter != null
            ? h('p', { class: 'muted small' },
                `${t('cal.rest', { n: formatNumber(projection.balanceAfter) })}`,
                projection.insufficient
                  ? h('strong', { class: 'danger-text' }, ` ${t('doses.insufficient')}`)
                  : null)
            : null,
          h('p', { class: 'disclaimer small' }, t('k.projected') + '. ' + t('treatment.scheduleHint')))
      );
    }

    if (!pendingPlans.length) {
      body.appendChild(
        h('div', { class: 'row' },
          quick && quick.value
            ? btn(t('cal.addHere'), {
                variant: 'accent', icon: 'syringe',
                onClick: () => { close(); openAdminForm({ patient, treatment, date, quick }); },
              })
            : btn(t('admin.create'), {
                variant: 'primary', icon: 'plus',
                onClick: () => { close(); openAdminForm({ patient, treatment, date }); },
              }))
      );
    }
  }

  const { close } = openDialog({
    title: t('cal.daySheetTitle', { date: fmtMedium(date) }),
    body,
    actions: [btn(t('app.close'), { variant: 'ghost', onClick: () => close() })],
    onClose: () => { closed = true; },
  });

  render();
  return { close, get closed() { return closed; } };
}
