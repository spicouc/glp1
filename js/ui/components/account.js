// Barra de compte i estat de sincronització (a la pantalla de pacients i fitxa).

import { h, btn, iconBtn, chip, icon } from '../dom.js';
import { t } from '../../i18n/index.js';
import { api } from '../../data/api.js';
import { sync, fullSync, syncLabel } from '../../data/sync.js';
import { navigate } from '../router.js';
import { update } from '../state.js';

/** Xip d'estat: Sincronitzat / Pendent / Sense servidor / Sessió caducada. */
export function syncChip({ compact = false } = {}) {
  const { text, tone } = syncLabel();
  const title = [
    sync.user ? `${t('sync.user')}: ${sync.user.username}` : '',
    sync.lastSync ? `${t('sync.last')} ${new Date(sync.lastSync).toLocaleString()}` : '',
    sync.error ? sync.error : '',
  ].filter(Boolean).join(' · ');

  return h(
    'button',
    {
      type: 'button',
      class: `syncchip syncchip--${tone} ${compact ? 'syncchip--compact' : ''}`,
      title: `${t('sync.title')}: ${text}. ${title}`,
      'aria-label': `${t('sync.title')}: ${text}`,
      onClick: async () => { await fullSync(); },
    },
    icon(sync.status === 'synced' ? 'check' : sync.status === 'offline' ? 'info' : 'clock'),
    compact ? null : h('span', {}, text)
  );
}

/** Botó d'administració (només admin). */
export function adminButton() {
  if (!sync.user || !sync.user.is_admin) return null;
  return iconBtn('users', t('admin.title'), () => navigate('#/admin'), { variant: 'ghost' });
}

/** Sortida de sessió. */
export function logoutButton() {
  return h(
    'button',
    {
      type: 'button',
      class: 'btn btn--ghost btn--icon',
      title: t('logout'),
      'aria-label': t('logout'),
      onClick: async () => {
        await api.logout();
        window.location.hash = '';
        window.location.reload();
      },
    },
    icon('close')
  );
}

/** Avis que l'administració encara té la contrasenya per defecte. */
export function defaultPasswordNotice() {
  if (!sync.passwordIsDefault) return null;
  return h(
    'div',
    { class: 'notice notice--warn notice--inline' },
    icon('alert'),
    h('div', {},
      h('strong', {}, t('admin.defaultPasswordTitle')),
      h('p', {}, t('admin.defaultPasswordBody')))
  );
}

/** Bloc complet per a la barra de la llista de pacients. */
export function accountBar() {
  return h('div', { class: 'accountbar' },
    syncChip(),
    adminButton(),
    logoutButton());
}
