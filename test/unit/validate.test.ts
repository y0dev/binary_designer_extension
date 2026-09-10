import assert from 'node:assert/strict';
import { validateDesign } from '../../src/core/validate';

test('a well-formed design validates', () => {
  const r = validateDesign({
    name: 'Frame',
    packing: 1,
    structs: { Vec3: { fields: [{ name: 'x', type: 'float32' }] } },
    fields: [
      { name: 'magic', type: 'uint32' },
      { name: 'v', type: 'Vec3' },
      { name: 'tag', type: 'char[8]' },
    ],
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.formRepresentable, true);
});

test('bad design name is an error', () => {
  const r = validateDesign({ name: 'struct', fields: [] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path === 'name'));
});

test('unknown type is an error', () => {
  const r = validateDesign({ name: 'F', fields: [{ name: 'a', type: 'uint33' }] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path.endsWith('.type')));
});

test('duplicate sibling field names', () => {
  const r = validateDesign({
    name: 'F',
    fields: [{ name: 'a', type: 'uint8' }, { name: 'a', type: 'uint8' }],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /duplicate field name "a"/.test(e.message)));
});

test('sized types require a size', () => {
  const r = validateDesign({ name: 'F', fields: [{ name: 'b', type: 'bytes' }] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path.endsWith('.size')));
});

test('bitfield widths may not exceed the container', () => {
  const r = validateDesign({
    name: 'F',
    fields: [{ name: 'f', type: 'uint8', bits: [
      { name: 'a', width: 4 }, { name: 'b', width: 5 },
    ] }],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /exceeds container/.test(e.message)));
});

test('countField must be an earlier integer sibling', () => {
  const forward = validateDesign({
    name: 'F',
    fields: [
      { name: 'items', type: 'uint16', array: { countField: 'n' } },
      { name: 'n', type: 'uint8' },
    ],
  });
  assert.equal(forward.ok, false);
  assert.ok(forward.errors.some((e) => /must appear before/.test(e.message)));

  const wrongType = validateDesign({
    name: 'F',
    fields: [
      { name: 'n', type: 'float32' },
      { name: 'items', type: 'uint16', array: { countField: 'n' } },
    ],
  });
  assert.equal(wrongType.ok, false);
  assert.ok(wrongType.errors.some((e) => /must be an integer field/.test(e.message)));
});

test('multi-dimensional arrays flip formRepresentable off but stay valid', () => {
  const r = validateDesign({ name: 'F', fields: [{ name: 'grid', type: 'int16[4][3]' }] });
  assert.equal(r.ok, true);
  assert.equal(r.formRepresentable, false);
});

test('enum keys must be integers and labels valid identifiers', () => {
  const r = validateDesign({
    name: 'F',
    fields: [{ name: 's', type: 'uint8', enum: { '0': 'ok', 'x': 'bad', '2': 'return' } }],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /enum key "x"/.test(e.message)));
  assert.ok(r.errors.some((e) => /reserved C\/C\+\+ keyword/.test(e.message)));
});

test('recursive struct is reported', () => {
  const r = validateDesign({
    name: 'F',
    structs: { A: { fields: [{ name: 'self', type: 'A' }] } },
    fields: [{ name: 'a', type: 'A' }],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /recursive struct/.test(e.message)));
});
