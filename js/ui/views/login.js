// Pantalla d'entrada (sessió). Sense token, no es carrega cap dada.

import { h, btn, icon } from '../dom.js';
import { api, ApiError } from '../../data/api.js';
import { formError, clearFormError } from '../modal.js';
import { t } from '../../i18n/index.js';

export function renderLogin({ message = '', onSuccess } = {}) {
  const errorSlot = h('div', { class: 'form__errors' });
  const user = h('input', { class: 'input', name: 'username', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false' });
  const pass = h('input', { class: 'input', name: 'password', type: 'password', autocomplete: 'current-password' });

  const form = h('form', { class: 'form', novalidate: true },
    h('div', { class: 'field' },
      h('span', { class: 'field__label' }, t('login.user')), user),
    h('div', { class: 'field' },
      h('span', { class: 'field__label' }, t('login.password')), pass),
    errorSlot,
    h('div', { class: 'row row--end' },
      btn(t('login.enter'), { variant: 'primary', type: 'submit', icon: 'user', block: true }))
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearFormError(form);
    const username = user.value.trim();
    const password = pass.value;
    if (!username || !password) {
      errorSlot.replaceChildren(formError(t('login.required')));
      return;
    }
    try {
      await api.login(username, password);
      if (onSuccess) onSuccess();
    } catch (err) {
      const text = err instanceof ApiError && err.status === 0
        ? t('login.offline')
        : (err && err.message) || t('login.error');
      errorSlot.replaceChildren(formError(text));
    }
  });

  const node = h(
    'div',
    { class: 'view view--login' },
    h('div', { class: 'login card' },
      h('div', { class: 'login__brand' },
        h('span', { class: 'login__logo' }, icon('syringe')),
        h('div', {},
          h('h1', { class: 'login__title' }, t('app.title')),
          h('p', { class: 'login__sub' }, t('login.subtitle')))),
      message ? h('div', { class: 'notice notice--warn' }, icon('info'), h('div', {}, message)) : null,
      form,
      h('p', { class: 'muted small' }, t('login.privacy')),
      h('p', { class: 'muted small' }, t('login.localCopy')))
  );

  setTimeout(() => user.focus(), 80);
  return node;
}
