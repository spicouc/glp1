// Helpers DOM mínims (sense dependències).

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === false || value === null || value === undefined) continue;
    if (key === 'class') el.className = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value' && (tag === 'input' || tag === 'select' || tag === 'textarea')) el.value = value;
    else if (key === 'checked' || key === 'disabled' || key === 'multiple' || key === 'selected') el[key] = Boolean(value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else if (child instanceof Node) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function text(el, value) {
  clear(el);
  el.appendChild(document.createTextNode(String(value)));
  return el;
}

export function el(sel, root = document) {
  return root.querySelector(sel);
}

export function frag(...children) {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

/** Icona SVG inline (traç simple, actualitza de 24px). */
export function icon(name, cls = '') {
  const paths = {
    chevronLeft: 'M15 18l-6-6 6-6',
    chevronRight: 'M9 18l6-6-6-6',
    plus: 'M12 5v14M5 12h14',
    check: 'M20 6L9 17l-5-5',
    close: 'M18 6L6 18M6 6l12 12',
    trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14',
    pencil: 'M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z',
    download: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3',
    upload: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12',
    archive: 'M21 8v13H3V8M1 3h22v5H1zM10 12h4',
    alert: 'M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z',
    info: 'M12 16v-4M12 8h.01M12 22a10 10 0 100-20 10 10 0 000 20z',
    calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z',
    syringe: 'M18 2l4 4M17 7l3-3M19 5l-8.5 8.5M14.5 4.5L7 12M10 8L3 15v6h6l7-7M6.5 17.5l3 3',
    pill: 'M10.5 20.5l10-10a4.95 4.95 0 10-7-7l-10 10a4.95 4.95 0 107 7zM8.5 8.5l7 7',
    scale: 'M3 12h4l3-9 4 18 3-9h4',
    clock: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 6v6l4 2',
    list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
    user: 'M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z',
    users: 'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75',
    edit: 'M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4L18.5 2.5z',
    minus: 'M5 12h14',
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', paths[name] || paths.info);
  svg.appendChild(p);
  return svg;
}

/** Barra de progrés (saldo de ploma). */
export function progressBar(value, max, { danger = false } = {}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return h(
    'div',
    { class: `progress ${danger ? 'progress--danger' : ''}`, role: 'progressbar', 'aria-valuenow': String(Math.max(0, value)), 'aria-valuemin': '0', 'aria-valuemax': String(max) },
    h('div', { class: 'progress__fill', style: `width:${pct.toFixed(1)}%` })
  );
}

export function chip(label, { tone = '', title = '' } = {}) {
  return h('span', { class: `chip ${tone ? `chip--${tone}` : ''}`, title }, label);
}

export function sectionCard(title, ...children) {
  return h(
    'section',
    { class: 'card' },
    title ? h('h3', { class: 'card__title' }, title) : null,
    ...children
  );
}

/** Camp de formulari amb etiqueta. */
export function field(label, control, { hint = '', error = '', required = false, inline = false } = {}) {
  return h(
    'label',
    { class: `field ${inline ? 'field--inline' : ''} ${error ? 'field--error' : ''}` },
    h('span', { class: 'field__label' }, label, required ? h('span', { class: 'field__req' }, ' *') : null),
    control,
    hint ? h('span', { class: 'field__hint' }, hint) : null,
    error ? h('span', { class: 'field__error' }, error) : null
  );
}

export function textField(label, { name, value = '', type = 'text', placeholder = '', required = false, hint = '', min, max, inputmode, pattern } = {}) {
  return field(
    label,
    h('input', { class: 'input', name, type, value, placeholder, required, min, max, inputmode, pattern }),
    { required, hint }
  );
}

export function numberField(label, { name, value = '', step, min, max, inputmode = 'numeric', hint = '' } = {}) {
  return field(label, h('input', { class: 'input', name, type: 'number', value, step, min, max, inputmode }), { hint });
}

export function textareaField(label, { name, value = '', rows = 3, placeholder = '', hint = '' } = {}) {
  return field(label, h('textarea', { class: 'input input--area', name, rows, placeholder }, value), { hint });
}

export function selectField(label, { name, value = '', options = [], required = false, hint = '', onchange } = {}) {
  const sel = h(
    'select',
    { class: 'input', name, required, onchange },
    options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label))
  );
  return field(label, sel, { required, hint });
}

export function btn(label, { onClick, variant = 'primary', icon: ic = '', type = 'button', disabled = false, title = '', block = false, cls = '' } = {}) {
  return h(
    'button',
    {
      type,
      class: `btn btn--${variant} ${block ? 'btn--block' : ''} ${cls}`,
      onClick,
      disabled,
      title,
      'aria-label': title || undefined,
    },
    ic ? icon(ic) : null,
    label ? h('span', { class: 'btn__label' }, label) : null
  );
}

export function iconBtn(name, label, onClick, { variant = 'ghost', disabled = false, cls = '' } = {}) {
  return h(
    'button',
    { type: 'button', class: `btn btn--icon btn--${variant} ${cls}`, onClick, disabled, title: label, 'aria-label': label },
    icon(name)
  );
}

export function emptyState(title, hint, action) {
  return h('div', { class: 'empty' }, h('p', { class: 'empty__title' }, title), hint ? h('p', { class: 'empty__hint' }, hint) : null, action || null);
}

export function formatNumber(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  const num = Number(n);
  const text = Number.isInteger(num) ? String(num) : String(Math.round(num * 1000) / 1000);
  // Separador decimal català
  return text.replace('.', ',');
}

/** Diners: cèntims enters → «129,00 €» (mai floats pel mig). */
export function formatEur(cents) {
  if (cents == null || !Number.isFinite(Number(cents))) return '—';
  return new Intl.NumberFormat('ca-ES', { style: 'currency', currency: 'EUR' })
    .format(Number(cents) / 100);
}

/* ---------- color de ploma -------------------------------------------- */

export const PEN_COLOR_COUNT = 8;

/** Número d'alta congelat d'una ploma: no canvia en esborrar-ne una altra. */
function penSeqOf(pens = [], penId) {
  const idx = pens.findIndex((p) => p.id === penId);
  if (idx < 0) return 0;
  const seq = Number(pens[idx].seq);
  return Number.isFinite(seq) && seq > 0 ? Math.round(seq) : idx + 1;
}

/** Classe CSS que assigna el color estable d'una ploma (segons el seu número). */
export function penColorClass(pens = [], penId) {
  const seq = penSeqOf(pens, penId);
  if (!seq) return '';
  return `pcolor-${((seq - 1) % PEN_COLOR_COUNT) + 1}`;
}

/** Número visible de la ploma (#1, #2, …) congelat a l'alta. */
export function penNumber(pens = [], penId) {
  const seq = penSeqOf(pens, penId);
  return seq ? String(seq) : '—';
}
