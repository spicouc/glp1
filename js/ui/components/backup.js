// Còpies de seguretat: exportació completa, exportació per pacient i
// importació amb validació d'esquema + confirmació explícita.

import { h, btn, icon, sectionCard, chip } from '../dom.js';
import { openDialog, confirmDialog, toast, formError } from '../modal.js';
import { t } from '../../i18n/index.js';
import { repo } from '../../data/localRepository.js';
import { validateBackup } from '../../core/validate.js';
import { fmtShort } from '../../core/dates.js';
import { update, state, loadPatients } from '../state.js';

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename, style: 'display:none' });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function exportAll() {
  downloadJson(repo.exportAll(), t('export.allFile'));
  state.lastExportAt = new Date().toISOString();
  toast(t('export.done'), { tone: 'ok' });
}

export function exportPatient(patient) {
  downloadJson(repo.exportPatient(patient.id), `pacient-${patient.code || patient.id}.json`);
  toast(t('export.done'), { tone: 'ok' });
}

function summaryLine(summary) {
  if (!summary) return null;
  return h('ul', { class: 'kv' },
    h('li', {}, h('strong', {}, `${summary.patients}`), ` ${t('patients.title').toLowerCase()}`),
    h('li', {}, h('strong', {}, `${summary.treatments}`), ` ${t('app.treatment').toLowerCase()}s`),
    h('li', {}, h('strong', {}, `${summary.pens}`), ` ${t('app.pens').toLowerCase()}`),
    h('li', {}, h('strong', {}, `${summary.administrations}`), ' administracions'),
    h('li', {}, h('strong', {}, `${summary.health}`), ' registres de salut'),
    summary.minDate ? h('li', {}, `Període: ${fmtShort(summary.minDate)} → ${fmtShort(summary.maxDate)}`) : null
  );
}

function errorsBlock(title, list, kind = 'error') {
  if (!list || !list.length) return null;
  return h('div', { class: `notice notice--${kind}` },
    h('strong', {}, title),
    h('ul', {}, list.slice(0, 12).map((e) => h('li', {}, e))),
    list.length > 12 ? h('p', { class: 'muted' }, `… +${list.length - 12}`) : null
  );
}

/** Diàleg d'importació: tria → validació → previsualització → mode. */
export function openImportDialog({ onDone } = {}) {
  const parsedCache = { data: null };
  const preview = h('div', { class: 'import__preview' });
  const input = h('input', { type: 'file', accept: 'application/json,.json', class: 'file', name: 'backup' });

  const close = () => dlg.close();
  let dlg = null;

  const renderInvalid = (errors) => {
    preview.replaceChildren(...[formError(t('export.invalid')), errorsBlock(t('export.errors'), errors)].filter(Boolean));
  };

  const run = async (mode) => {
    try {
      const result = repo.importBackup(parsedCache.data, mode);
      if (!result.ok) {
        renderInvalid(result.errors);
        return;
      }
      loadPatients();
      update('import');
      close();
      toast(t('export.ok', { added: result.added, updated: result.updated }), { tone: 'ok' });
      if (onDone) onDone(result);
    } catch (err) {
      preview.replaceChildren(formError(err.message));
    }
  };

  const renderPreview = () => {
    const parsed = parsedCache.data;
    const check = validateBackup(parsed);
    const items = [
      h('h3', { class: 'subhead' }, t('export.preview')),
      summaryLine(check.summary),
      errorsBlock(t('export.warnings'), check.warnings, 'warn'),
      errorsBlock(t('export.errors'), check.errors),
      h('div', { class: 'notice notice--warn' },
        icon('alert'),
        h('div', {}, h('strong', {}, t('export.replace')), h('p', {}, t('export.replaceWarn')))),
      h('div', { class: 'row row--end' },
        btn(t('export.merge'), { variant: 'secondary', disabled: !check.ok, onClick: () => run('merge') }),
        btn(t('export.replace'), {
          variant: 'danger',
          disabled: !check.ok,
          onClick: async () => {
            const ok = await confirmDialog(t('export.confirmReplace'), { okLabel: t('export.replace') });
            if (ok) await run('replace');
          },
        })),
    ];
    preview.replaceChildren(...items.filter(Boolean));
  };

  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        parsedCache.data = JSON.parse(String(reader.result));
        renderPreview();
      } catch (err) {
        parsedCache.data = null;
        renderInvalid([String(err.message)]);
      }
      input.value = '';
    };
    reader.readAsText(file);
  });

  const body = h('div', { class: 'import' },
    h('p', { class: 'muted' }, t('export.desc')),
    h('label', { class: 'field' },
      h('span', { class: 'field__label' }, t('export.pick')),
      input),
    preview
  );

  dlg = openDialog({
    title: t('export.importTitle'),
    body,
    actions: [btn(t('app.close'), { variant: 'ghost', onClick: () => close() })],
  });
}

/** Panell de còpies de seguretat (accions principals). */
export function openBackupDialog({ patient = null } = {}) {
  const body = h('div', {},
    h('p', { class: 'muted' }, t('export.desc')),
    h('p', { class: 'muted small' }, t('export.storage', { kb: Math.max(1, Math.round((repo.usage().bytes / 1024) * 10) / 10) })),
    sectionCard(
      null,
      h('div', { class: 'stack' },
        btn(t('export.all'), { variant: 'primary', icon: 'download', block: true, onClick: () => exportAll() }),
        patient ? btn(t('export.one'), { variant: 'secondary', icon: 'download', block: true, onClick: () => exportPatient(patient) }) : null,
        btn(t('export.import'), { variant: 'secondary', icon: 'upload', block: true, onClick: () => { close(); openImportDialog(); } })
      )
    ),
    patient ? h('p', { class: 'muted small' }, t('export.oneFile', { code: patient.code })) : chip(t('export.allFile'))
  );

  const { close } = openDialog({
    title: t('export.title'),
    body,
    actions: [btn(t('app.close'), { variant: 'ghost', onClick: () => close() })],
  });
}
