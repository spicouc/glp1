// Diàlegs, confirmacions i avisos efímers.

import { h, btn, icon } from './dom.js';
import { t } from '../i18n/index.js';

function ensureOverlay() {
  let layer = document.getElementById('ui-layers');
  if (!layer) {
    layer = h('div', { id: 'ui-layers' });
    document.body.appendChild(layer);
  }
  return layer;
}

/**
 * Obre un diàleg modal. `body` pot ser Node | string | array de nodes.
 * Retorna { close, el }.
 */
export function openDialog({ title, body, actions = [], size = 'md', dismissible = true, onClose } = {}) {
  const layer = ensureOverlay();
  const dialog = h('div', { class: 'dialog dialog--' + size, role: 'dialog', 'aria-modal': 'true', 'aria-label': typeof title === 'string' ? title : '' });
  const backdrop = h('div', { class: 'dialog__backdrop' });

  const close = () => {
    backdrop.remove();
    dialog.remove();
    document.body.classList.remove('has-dialog');
    if (onClose) onClose();
  };

  if (dismissible) backdrop.addEventListener('click', close);

  const header = h(
    'header',
    { class: 'dialog__header' },
    h('h2', { class: 'dialog__title' }, title),
    h('button', { type: 'button', class: 'btn btn--icon btn--ghost', onClick: close, 'aria-label': t('app.close') }, icon('close'))
  );

  const content = h('div', { class: 'dialog__body' });
  if (typeof body === 'string') content.textContent = body;
  else if (Array.isArray(body)) body.filter(Boolean).forEach((n) => content.appendChild(n));
  else if (body) content.appendChild(body);

  const footer = actions.length
    ? h('footer', { class: 'dialog__footer' }, actions)
    : null;

  dialog.append(header, content, ...(footer ? [footer] : []));
  layer.append(backdrop, dialog);
  document.body.classList.add('has-dialog');

  const focusable = dialog.querySelector('input, select, textarea, button.btn--primary');
  if (focusable) setTimeout(() => focusable.focus(), 60);

  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dismissible) close();
  });

  return { el: dialog, close };
}

/** Confirmació explícita per a accions destructives. */
export function confirmDialog(message, { okLabel, danger = true, title } = {}) {
  return new Promise((resolve) => {
    let finished = false;
    const { close } = openDialog({
      title: title || t('app.confirm'),
      body: h('p', { class: 'dialog__text' }, message),
      actions: [
        btn(t('app.cancel'), { variant: 'ghost', onClick: () => { finished = true; resolve(false); close(); } }),
        btn(okLabel || t('app.confirm'), {
          variant: danger ? 'danger' : 'primary',
          onClick: () => { finished = true; resolve(true); close(); },
        }),
      ],
      onClose: () => { if (!finished) resolve(false); },
    });
  });
}

let toastTimer = null;

/** Avisos breus amb acció opcional (ex. "Desfés"). */
export function toast(message, { tone = 'ok', actionLabel, onAction, duration = 5000 } = {}) {
  const layer = ensureOverlay();
  const old = document.getElementById('app-toast');
  if (old) old.remove();
  if (toastTimer) clearTimeout(toastTimer);

  const node = h(
    'div',
    { id: 'app-toast', class: `toast toast--${tone}`, role: 'status' },
    h('span', { class: 'toast__msg' }, message),
    actionLabel
      ? h('button', {
          type: 'button',
          class: 'toast__action',
          onClick: () => {
            node.remove();
            if (onAction) onAction();
          },
        }, actionLabel)
      : null
  );
  layer.appendChild(node);
  toastTimer = setTimeout(() => node.remove(), duration);
  return node;
}

/** Avisos de validació dins d'un formulari. */
export function formError(message) {
  return h('p', { class: 'form-error', role: 'alert' }, icon('alert'), h('span', {}, message));
}

export function clearFormError(form) {
  const existing = form.querySelector('.form-error');
  if (existing) existing.remove();
}
