import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepository, memoryAdapter } from '../js/data/repository.js';
import { migrate, freshDb, CURRENT_VERSION } from '../js/data/migrations.js';
import { validateBackup } from '../js/core/validate.js';
import { createPatient, createTreatment, createPen, createAdministration, createSchedule, normalisePatient } from '../js/core/model.js';

function seed() {
  const p = createPatient({ code: 'P-001', name: 'Anna' });
  const t = createTreatment({ drugId: 'mounjaro', startDate: '2026-11-01' });
  const pen = createPen({ presentationMg: 10, initialCapacity: 240, capacityUnit: 'clicks' });
  t.pens.push(pen);
  t.schedules = [createSchedule({ startDate: '2026-11-01', mode: 'clicks', value: 15, intervalDays: 7 })];
  t.administrations.push(
    createAdministration({ date: '2026-11-01', penId: pen.id, mode: 'clicks', value: 15, amount: 15, unit: 'clicks', mg: 2.5 })
  );
  p.treatments.push(t);
  return p;
}

test('el repositori desa, llegeix i actualitza pacients', () => {
  const repo = createRepository(memoryAdapter());
  const p = seed();
  repo.save(p);

  const list = repo.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].code, 'P-001');

  const fetched = repo.get(p.id);
  assert.equal(fetched.treatments[0].administrations.length, 1);

  fetched.notes = 'nota nova';
  repo.save(fetched);
  assert.equal(repo.get(p.id).notes, 'nota nova');
  assert.equal(repo.list().length, 1);
});

test('exportació completa i exportació individual', () => {
  const repo = createRepository(memoryAdapter());
  const p = seed();
  repo.save(p);

  const all = repo.exportAll();
  assert.equal(all.schemaVersion, CURRENT_VERSION);
  assert.equal(all.patients.length, 1);
  assert.ok(all.exportedAt);

  const one = repo.exportPatient(p.id);
  assert.equal(one.patients.length, 1);
  assert.equal(one.patients[0].code, 'P-001');
  assert.equal(repo.exportPatient('no-existeix'), null);

  assert.ok(validateBackup(all).ok);
});

test('importació: no substitueix la base sense mode explícit', () => {
  const repo = createRepository(memoryAdapter());
  const existing = seed();
  repo.save(existing);

  const other = createPatient({ code: 'P-002' });
  const result = repo.importBackup({ schemaVersion: 1, patients: [other] }, 'merge');
  assert.ok(result.ok);
  assert.equal(result.added, 1);
  assert.equal(repo.list().length, 2, 'merge afegeix, no sobreescriu');

  const replace = repo.importBackup({ schemaVersion: 1, patients: [other] }, 'replace');
  assert.equal(replace.added, 1);
  assert.equal(repo.list().length, 1);
  assert.equal(repo.list()[0].code, 'P-002');
});

test('importació rebutja fitxers invàlids o de versió futura', () => {
  const repo = createRepository(memoryAdapter());
  repo.save(seed());

  assert.equal(repo.importBackup('no-json', 'replace').ok, false);
  assert.equal(repo.importBackup({ schemaVersion: 99, patients: [] }, 'replace').ok, false);
  assert.equal(
    repo.importBackup({ schemaVersion: 1, patients: [{ id: 'x', treatments: [] }] }, 'replace').ok,
    false,
    'sense code no és vàlid'
  );
  assert.equal(repo.list().length, 1, 'la base no s\'ha tocat');
});

test('mateix pacient i codis duplicats en afegir', () => {
  const repo = createRepository(memoryAdapter());
  const existing = seed();
  repo.save(existing);

  // Mateix id: s'actualitza, no es duplica.
  const same = normalisePatient(existing);
  same.notes = 'actualitzat';
  const update = repo.importBackup({ schemaVersion: 1, patients: [same] }, 'merge');
  assert.equal(update.updated, 1);
  assert.equal(repo.list().length, 1);
  assert.equal(repo.get(existing.id).notes, 'actualitzat');

  // Mateix codi però altre id: es conserva l'existent i l'entrant rep codi nou.
  const clone = normalisePatient(existing);
  clone.id = 'altre_id';
  clone.notes = '';
  const result = repo.importBackup({ schemaVersion: 1, patients: [clone] }, 'merge');
  assert.ok(result.ok);
  assert.equal(result.added, 1);
  assert.equal(repo.list().length, 2);
  const added = repo.list().find((p) => p.id === 'altre_id');
  assert.equal(added.code, 'P-001*');
});

test('migració d\'esquema: versió 0 i càrrega', () => {
  const legacy = { patients: [{ id: 'a', code: 'P-009', name: '', treatments: [] }] };
  const migrated = migrate(legacy);
  assert.equal(migrated.schemaVersion, CURRENT_VERSION);
  assert.equal(migrated.patients[0].code, 'P-009');
  assert.equal(migrated.patients[0].archived, false);

  assert.throws(() => migrate({ schemaVersion: 99, patients: [] }), /versió més nova/);
  assert.equal(freshDb().patients.length, 0);
});

test('corrupció de localStorage no impedeix arrencar', () => {
  const repo = createRepository(memoryAdapter('{{{ trencat'));
  assert.throws(() => repo.list(), /No s'ha pogut carregar/);
  repo.reset();
  assert.deepEqual(repo.list(), []);
});

test('esborrat suau: tomba que no es mostra però sí viatja amb el sync', () => {
  const repo = createRepository(memoryAdapter());
  const p = seed();
  repo.save(p);
  assert.ok(repo.usage().bytes > 0);

  assert.equal(repo.remove(p.id), true);
  assert.equal(repo.remove(p.id), false, 'idempotent: la segona vegada ja és tomba');

  assert.equal(repo.list().length, 0, 'no es mostra a la llista normal');
  const withDeleted = repo.list({ includeDeleted: true });
  assert.equal(withDeleted.length, 1, 'la tomba sí que viatja amb la sincronització');
  assert.ok(withDeleted[0].deletedAt, 'té data d\'esborrat');
  assert.ok(withDeleted[0].updatedAt, 'incrementa updatedAt per guanyar el merge');
  assert.ok(repo.get(p.id), 'get la continua trobant (la usa el sync)');
  assert.equal(repo.exportAll().patients.length, 0, 'la còpia de seguretat no inclou esborrats');
});
