// Utilitats compartides de les proves E2E: base d'usuaris i aïllament.
//
//   npm run e2e  (cal el servei a marxa: docker compose up -d)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Per defecte es prova la pila AÏLLADA (8098). La de producció (8099) només
// es fa servir si s'hi apunta explícitament amb BASE_URL (i llavors valen el
// snapshot + la restauració del runner).
export const BASE = process.env.BASE_URL || `http://127.0.0.1:${process.env.GLP1_E2E_PORT || '8098'}/`;
export const SHOTS = process.env.SHOTS_DIR || '/tmp/opencode/glp1-shots';

/** Credencials d'administració: env o fitxer .env del projecte. */
export function credentials() {
  const user = process.env.GLP1_ADMIN_USER || 'admin';
  let pass = process.env.GLP1_ADMIN_PASSWORD;
  if (!pass) {
    try {
      const raw = fs.readFileSync(path.join(here, '..', '.env'), 'utf8');
      const match = /^GLP1_ADMIN_PASSWORD=(.+)$/m.exec(raw);
      if (match) pass = match[1].trim();
    } catch { /* sense .env */ }
  }
  return { user, pass: pass || 'admin1234-change-me' };
}

/** On es desa la còpia de seguretat del servidor abans de buidar-lo. */
export const SNAPSHOT = process.env.E2E_SNAPSHOT || '/tmp/opencode/glp1-e2e-server-snapshot.json';

/** Token d'API (login amb les credencials del projecte). */
export async function apiToken() {
  const { user, pass } = credentials();
  const loginRes = await fetch(new URL('api/auth/login', BASE), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass }),
  });
  if (!loginRes.ok) throw new Error('login fallit: ' + await loginRes.text());
  return (await loginRes.json()).token;
}

/**
 * Desa una còpia de tots els pacients del servidor abans de buidar-lo.
 * Mai sobreescriu un snapshot amb un servidor buit (així, si una execució queda
 * a mitges, la còpia bona es conserva).
 */
export async function snapshotServer() {
  const token = await apiToken();
  const res = await fetch(new URL('api/patients', BASE), { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error('GET /api/patients fallit: ' + await res.text());
  const data = await res.json();
  const current = Array.isArray(data.patients) ? data.patients : [];

  // També el catàleg de fàrmacs: les proves d'administració el poden editar.
  let currentDrugs = null;
  try {
    const r = await fetch(new URL('api/drugs', BASE), { headers: { Authorization: `Bearer ${token}` } });
    if (r.ok) currentDrugs = (await r.json()).drugs || [];
  } catch { /* el catàleg no és imprescindible */ }

  const prev = fs.existsSync(SNAPSHOT)
    ? JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'))
    : null;
  const prevPatients = prev && Array.isArray(prev.patients) ? prev.patients : null;

  // Es pren l'estat ACTUAL. L'únic cas en què es conserva l'anterior snapshot
  // és quan el servidor surt buit (execució caiguda després de buidar-lo).
  const patients = current.length ? current : (prevPatients || []);
  const drugs = currentDrugs;

  fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
  fs.writeFileSync(SNAPSHOT, JSON.stringify({ patients, ...(drugs ? { drugs } : {}) }, null, 2));
  return { patients, ...(drugs ? { drugs } : {}) };
}

/** Torna a pujar el snapshot (merge per `updatedAt`; no es perden dades). */
export async function restoreServer() {
  if (!fs.existsSync(SNAPSHOT)) return { ok: false, reason: 'no-snapshot' };
  const data = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  const patients = Array.isArray(data.patients) ? data.patients : [];
  const drugs = Array.isArray(data.drugs) ? data.drugs : null;
  const token = await apiToken();

  let out = {};
  if (patients.length) {
    // Restauració EXACTA: primer s'esbora tot (inclòs el que les proves hagin
    // deixat) i després es torna a pujar el snapshot. Si el PUT fallés, el
    // fitxer es conserva i `npm run e2e:restore` ho torna a intentar.
    const del = await fetch(new URL('api/patients', BASE), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!del.ok) throw new Error('DELETE (restauració) fallit: ' + await del.text());
    const res = await fetch(new URL('api/patients', BASE), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ patients }),
    });
    if (!res.ok) throw new Error('PUT /api/patients fallit: ' + await res.text());
    out = await res.json();
  }
  if (drugs && drugs.length) {
    const res = await fetch(new URL('api/drugs', BASE), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ drugs }),
    });
    if (!res.ok) throw new Error('PUT /api/drugs fallit: ' + await res.text());
  }
  return { ok: true, patients: patients.length, drugs: drugs ? drugs.length : 0, created: out.created, updated: out.updated, kept: out.kept };
}

/** Buida la base de dades del servidor perquè cada provingui aïllada.
 *  Abans DESA una còpia per poder-la restaurar (execucions manuals incloses). */
export async function resetServer() {
  try {
    if (!fs.existsSync(SNAPSHOT)) await snapshotServer();
  } catch (err) {
    console.warn("⚠ No s'ha pogut fer snapshot abans de buidar: " + err.message);
  }
  const token = await apiToken();
  const del = await fetch(new URL('api/patients', BASE), {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!del.ok) throw new Error('DELETE fallit: ' + await del.text());
  return true;
}

/** Entra a l'aplicació i espera la llista de pacients. */
export async function login(page) {
  const { user, pass } = credentials();
  await page.waitForSelector('.view--login', { timeout: 20000 });
  await page.fill('.view--login input[name="username"]', user);
  await page.fill('.view--login input[name="password"]', pass);
  await page.click('.view--login button[type="submit"]');
  await page.waitForSelector('.view--patients', { timeout: 20000 });
}

/** Espera que l'indicador digui "Sincronitzat". */
export async function waitForSynced(page, timeout = 15000) {
  await page.waitForFunction(
    () => {
      const chip = document.querySelector('.syncchip');
      return chip && /Sincronitzat/.test(chip.textContent || '');
    },
    { timeout }
  );
}
