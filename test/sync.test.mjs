// Sincronització i catàleg editable: la lògica pura de merge i d'edicions.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mergePatientLists, stamp, syncLabel, sync } from '../js/data/sync.js';
import { drugList, getDrug, setDrugCatalog, serializeDrug, resolveConversion, CATALOG_VERSION } from '../js/core/drugs.js';
import { createInitialPen } from '../js/core/model.js';

const p = (id, updatedAt, code) => ({ id, updatedAt, code, treatments: [] });

test('merge: guanya sempre el updatedAt més recent (cap banda perd dades)', () => {
  const local = [p('a', '2026-11-24T10:00:00Z', 'LOCAL-A'), p('b', '2026-11-24T09:00:00Z', 'LOCAL-B')];
  const remote = [p('a', '2026-11-24T12:00:00Z', 'SERVIDOR-A'), p('c', '2026-11-24T08:00:00Z', 'SERVIDOR-C')];

  const { merged, pulled, localNewer, created } = mergePatientLists(local, remote);
  const byId = Object.fromEntries(merged.map((x) => [x.id, x.code]));

  assert.equal(merged.length, 3, 'unió dels dos costats');
  assert.equal(byId.a, 'SERVIDOR-A', 'guanya el servidor (més recent)');
  assert.equal(byId.b, 'LOCAL-B', 'només local → es conserva');
  assert.equal(byId.c, 'SERVIDOR-C', 'només servidor → es crea');
  assert.deepEqual(pulled.sort(), ['a']);
  assert.deepEqual(localNewer.sort(), ['b']);
  assert.deepEqual(created, ['c']);
});

test('merge: el local més recent guanya sobre el servidor', () => {
  const local = [p('x', '2026-11-24T15:00:00Z', 'LOCAL-NOVA')];
  const remote = [p('x', '2026-11-24T11:00:00Z', 'SERVIDOR-VELLA')];
  const { merged, localNewer } = mergePatientLists(local, remote);
  assert.equal(merged[0].code, 'LOCAL-NOVA');
  assert.deepEqual(localNewer, ['x'], 'caldrà pujar-la');
});

test('merge: idèntic i sense dades de sincronització', () => {
  assert.deepEqual(mergePatientLists([], []).merged, []);
  const same = [p('z', '2026-11-24T10:00:00Z', 'Z')];
  const { merged, pulled, localNewer, created } = mergePatientLists(same, same);
  assert.equal(merged.length, 1);
  assert.deepEqual(pulled, []);
  assert.deepEqual(localNewer, [], 'en empat no cal pujar res (mateix contingut)');
  assert.deepEqual(created, []);
});

test('les tombes (pacients esborrats) es propaguen en els dos sentits', () => {
  const tomba = { id: 'd', code: 'P-D', updatedAt: '2026-11-24T10:00:00Z', deletedAt: '2026-11-24T10:00:00Z' };

  // arriba del servidor → es guarda amb deletedAt (l'UI la filtrarà)
  const baixada = mergePatientLists([], [tomba]);
  assert.equal(baixada.merged.length, 1);
  assert.ok(baixada.merged[0].deletedAt);

  // local viu + tomba al servidor: guanya la tomba més recent
  const localViu = { id: 'd', code: 'P-D', updatedAt: '2026-11-24T09:00:00Z' };
  const res = mergePatientLists([localViu], [tomba]);
  assert.ok(res.merged[0].deletedAt, 'guanya la tomba més recent');

  // local esborra més tard que el servidor → guanya el local
  const tombaNova = { id: 'd', code: 'P-D', updatedAt: '2026-11-24T12:00:00Z', deletedAt: '2026-11-24T12:00:00Z' };
  const res2 = mergePatientLists([tombaNova], [tomba]);
  assert.equal(res2.merged[0].deletedAt, tombaNova.deletedAt);
  assert.ok(res2.localNewer.includes('d'), 'cal pujar la tomba');
});

test('stamp: usa updatedAt i, si no n\'hi ha, createdAt', () => {
  assert.equal(stamp({ updatedAt: '2026-01-01T00:00:00Z' }), '2026-01-01T00:00:00Z');
  assert.equal(stamp({ createdAt: '2025-01-01T00:00:00Z' }), '2025-01-01T00:00:00Z');
  assert.equal(stamp({}), '');
  assert.equal(stamp(null), '');
});

test('indicador d\'estat comprensible per a la interfície', () => {
  const states = ['syncing', 'pending', 'synced', 'offline', 'unauthorised', 'error', 'no-session', 'idle'];
  for (const s of states) {
    sync.status = s;
    const { text, tone } = syncLabel();
    assert.ok(typeof text === 'string' && text.length > 0, s);
    assert.ok(tone, s);
  }
  sync.status = 'offline';
  assert.match(syncLabel().text, /Sense servidor/);
  sync.status = 'synced';
  assert.match(syncLabel().text, /Sincronitzat/);
});

test('catàleg editable: setDrugCatalog aplica les edicions i preserva la lògica', () => {
  // l'edició de l'admin arriba en JSON (sense funcions)
  const edited = [
    // l'administració segella la versió actual en desar
    { id: 'ozempic', label: 'Ozempic', catalogVersion: CATALOG_VERSION, standardDosesMg: [0.25, 0.5, 1, 2, 3], clickMode: 'unsupported' },
    { id: 'noufarma', label: 'Nou Fàrmac', activeSubstance: 'exemplum', frequency: 'weekly',
      standardDosesMg: [1, 2], penStrengthsMg: null, capacityUnit: 'doses',
      defaultInitialCapacity: 4, clickMode: 'fixed-dose' },
  ];

  const n = setDrugCatalog(edited);
  assert.ok(n >= 3, 'manté els fàrmacs base i afegeix els nous');

  // dosis estàndard editades
  assert.deepEqual(getDrug('ozempic').standardDosesMg, [0.25, 0.5, 1, 2, 3]);
  assert.ok(drugList().some((d) => d.id === 'noufarma'), 'fàrmac creat per l\'admin disponible');
  assert.equal(drugList().find((d) => d.id === 'ozempic').id, 'ozempic');

  // la lògica del base no es perd (funcions no enviades en JSON)
  const pen = createInitialPen('mounjaro', '2026-11-01');
  const conv = resolveConversion(pen, getDrug('mounjaro'));
  assert.ok(conv && conv.mgPerClick > 0, 'mgPerClick (funció) es conserva després de la càrrega');

  // Un catàleg ANTIC (sense versió o amb una versió anterior) no es pot quedar
  // camps nous pendents: es conserva el base de l'app fins que l'admin desi.
  const ozempicBefore = JSON.parse(JSON.stringify(getDrug('ozempic').penStrengthsMg));
  setDrugCatalog([{ id: 'ozempic', penStrengthsMg: null, standardDosesMg: [9] }]);
  assert.deepEqual(getDrug('ozempic').standardDosesMg, [0.25, 0.5, 1, 2, 3], 'catàleg vell descartat (manté l·últim)');
  setDrugCatalog([{ id: 'ozempic', catalogVersion: 1, standardDosesMg: [9] }]);
  assert.deepEqual(getDrug('ozempic').standardDosesMg, [0.25, 0.5, 1, 2, 3], 'versió 1 < 2 → es conserva el base');
  assert.ok(Array.isArray(ozempicBefore), 'presentacions d·Ozempic disponibles per triar');

  // serialització per pujar al servidor: sense funcions
  const json = serializeDrug(getDrug('mounjaro'));
  assert.equal(json.standardDosesMg.length, 6);
  assert.ok(!('mgPerClick' in json), 'les funcions no es serialitzen');
  assert.doesNotThrow(() => JSON.stringify(json));
});
