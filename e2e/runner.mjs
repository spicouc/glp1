// Executa les suites E2E amb còpia de seguretat i restauració del servidor.
//
//   npm run e2e                -> snapshot → 4 suites → restaura
//   npm run e2e -- --restore   -> només restaura l'últim snapshot
//
// Motiu: `resetServer()` buida la base del servidor perquè cada provingui aïllada.
// Amb dades reals això seria perillós, així que abans de començar es desa una
// còpia i al final es torna a pujar (merge per `updatedAt`, sense pèrdues).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { snapshotServer, restoreServer, SNAPSHOT } from './helpers.mjs';

/** Reintents: la xarxa/docker pot trontollar un instant. */
async function retry(fn, label, times = 3) {
  let lastErr;
  for (let i = 1; i <= times; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const why = err && err.cause ? `${err.message} (${err.cause.code || err.cause.message || ''})` : err.message;
      console.warn(`⚠ ${label}: intent ${i}/${times} fallit — ${why}`);
      if (i < times) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}

const SUITES = ['smoke', 'pens', 'planner', 'paint', 'planestats', 'inventory', 'backup', 'sync'];
const E2E_PORT = process.env.GLP1_E2E_PORT || '8098';

/** Arrenca la pila E2A aïllada (no toca mai la de producció del 8099). */
function ensureStack() {
  if (process.env.BASE_URL) return; // l'usuari ha triat un altre servidor
  console.log(`▶ Assegurant la pila E2E aïllada (:${E2E_PORT})…`);
  const env = { ...process.env, GLP1_PORT: E2E_PORT };
  const res = spawnSync('docker', [
    'compose', '-p', 'glp1e2e',
    '-f', 'docker-compose.yml', '-f', 'docker-compose.e2e.yml',
    'up', '-d', '--build',
  ], { stdio: 'inherit', env });
  if (res.status !== 0) {
    console.error('✗ No s\'ha pogut arrencar la pila E2E (docker compose)');
    process.exit(1);
  }
}

async function restoreOnly() {
  const res = await restoreServer();
  if (!res.ok) {
    console.error(`✗ No hi ha cap snapshot per restaurar (${SNAPSHOT})`);
    process.exit(1);
  }
  console.log(`✓ Servidor restaurat: ${res.patients} pacients (${res.created ?? 0} creats, ${res.updated ?? 0} actualitzats, ${res.kept ?? 0} conservats)`);
}

if (process.argv.includes('--restore')) {
  restoreOnly();
} else {
  ensureStack();
  const failures = [];
  let snapshot;
  try {
    snapshot = await retry(snapshotServer, 'snapshot');
    console.log(`▶ Snapshot: ${snapshot.patients.length} pacients · ${snapshot.drugs?.length ?? 0} fàrmacs (${SNAPSHOT})`);
  } catch (err) {
    console.error('✗ No s\'ha pogut fer la còpia de seguretat: ' + err.message);
    process.exit(1);
  }

  try {
    for (const suite of SUITES) {
      console.log(`\n══════════ ${suite}.mjs ══════════`);
      const res = spawnSync(process.execPath, [`e2e/${suite}.mjs`], { stdio: 'inherit', env: process.env });
      if (res.status !== 0) failures.push(suite);
    }
  } finally {
    try {
      const res = await retry(restoreServer, 'restauració');
      fs.rmSync(SNAPSHOT, { force: true });
      if (res.ok) {
        console.log(`\n✓ Servidor restaurat: ${res.patients} pacients · ${res.drugs ?? 0} fàrmacs (${res.created ?? 0} creats, ${res.updated ?? 0} actualitzats, ${res.kept ?? 0} conservats)`);
      } else {
        console.warn('⚠ Sense snapshot a restaurar');
      }
    } catch (err) {
      const why = err && err.cause ? `${err.message} (${err.cause.code || err.cause.message || ''})` : err.message;
      console.error('✗ Error restaurant el servidor: ' + why);
      failures.push('restauració');
    }
  }

  if (failures.length) {
    console.error('\n✗ Suites fallides: ' + failures.join(', '));
    process.exit(1);
  }
  console.log(`\n✓ ${SUITES.length} suites E2E verdes · servidor restaurat`);
}
