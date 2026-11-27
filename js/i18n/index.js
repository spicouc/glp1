// Registre d'idiomes. La UI només crida t(); canviar d'idioma no toca res més.

import { t as caT, tStatus as caStatus, hasKey as caHasKey } from './ca.js';

const dict = { ca: caT };
const statusDict = { ca: caStatus };
let current = 'ca';

export function registerLocale(code, fn) {
  dict[code] = fn;
}

export function setLocale(code) {
  if (dict[code]) current = code;
  return current;
}

export function currentLocale() {
  return current;
}

export function t(key, vars) {
  const fn = dict[current] || dict.ca;
  return fn(key, vars);
}

/** Estats (pen.status.*, treatment.status...) resolts a l'idioma actual. */
export function tStatus(group, value) {
  const fn = statusDict[current] || statusDict.ca;
  return fn(group, value);
}

export function hasKey(key) {
  const fn = dict[current] || dict.ca;
  return fn.hasKey ? fn.hasKey(key) : caHasKey(key);
}
