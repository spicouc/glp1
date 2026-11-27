// Utilitats de dates. Totes les dates de l'aplicació són cadenes 'YYYY-MM-DD'
// (sense zona horària) perquè el registre clínic no depèn del rellotge del dispositiu.

const MS_DAY = 86400000;

export const MONTHS_CA = [
  'gener', 'febrer', 'març', 'abril', 'maig', 'juny',
  'juliol', 'agost', 'setembre', 'octubre', 'novembre', 'desembre',
];

export const WEEKDAYS_CA = ['dl', 'dm', 'dc', 'dj', 'dv', 'ds', 'dg'];

const pad = (n) => String(n).padStart(2, '0');

export function todayISO() {
  return toISO(new Date());
}

export function toISO(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseISO(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function isValidISO(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = parseISO(s);
  return !Number.isNaN(d.getTime()) && toISO(d) === s;
}

export function addDays(s, n) {
  const d = parseISO(s);
  d.setDate(d.getDate() + n);
  return toISO(d);
}

/** Dies de b a a (positiu si a és posterior). */
export function diffDays(a, b) {
  return Math.round((parseISO(b) - parseISO(a)) / MS_DAY);
}

export function cmpDates(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function minDate(...list) {
  return list.filter(Boolean).sort(cmpDates)[0] || null;
}

export function maxDate(...list) {
  return list.filter(Boolean).sort(cmpDates).pop() || null;
}

/** Dilluns = 0 ... diumenge = 6 */
export function weekdayMon(iso) {
  const js = parseISO(iso).getDay();
  return (js + 6) % 7;
}

export function startOfMonth(iso) {
  const d = parseISO(iso);
  return toISO(new Date(d.getFullYear(), d.getMonth(), 1));
}

export function addMonths(iso, n) {
  const d = parseISO(iso);
  return toISO(new Date(d.getFullYear(), d.getMonth() + n, 1));
}

/** Graella completa del mes (files de dilluns a diumenge) a partir de qualsevol dia del mes. */
export function monthGrid(iso) {
  const first = startOfMonth(iso);
  const d = parseISO(first);
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const offset = weekdayMon(first);
  const rows = [];
  let cursor = addDays(first, -offset);
  const total = Math.ceil((offset + daysInMonth) / 7) * 7;
  for (let i = 0; i < total; i++) {
    rows.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return rows;
}

export function monthLabel(iso) {
  const d = parseISO(startOfMonth(iso));
  return `${MONTHS_CA[d.getMonth()]} de ${d.getFullYear()}`;
}

export function isSameMonth(a, b) {
  return startOfMonth(a) === startOfMonth(b);
}

/** 15/11/2026 */
export function fmtShort(iso) {
  if (!isValidISO(iso)) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** 22/11/26 (compacte per a targetes i estadístiques) */
export function fmtCompact(iso) {
  if (!isValidISO(iso)) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y.slice(2)}`;
}

/** 15 de novembre de 2026 */
export function fmtLong(iso) {
  if (!isValidISO(iso)) return '—';
  const d = parseISO(iso);
  return `${d.getDate()} de ${MONTHS_CA[d.getMonth()]} de ${d.getFullYear()}`;
}

/** 15 novembre 2026 (per a la fitxa del dia) */
export function fmtMedium(iso) {
  if (!isValidISO(iso)) return '—';
  const d = parseISO(iso);
  return `${d.getDate()} ${MONTHS_CA[d.getMonth()]} ${d.getFullYear()}`;
}
