import assert from 'node:assert/strict';
import { computeLayout } from '../../src/core/layout';
import { Design } from '../../src/core/types';

function d(partial: Partial<Design>): Design {
  return { name: 'T', endianness: 'little', packing: 1, fields: [], ...partial } as Design;
}

test('pack(1): scalars are byte-packed', () => {
  const l = computeLayout(d({
    packing: 1,
    fields: [
      { name: 'a', type: 'uint8' },
      { name: 'b', type: 'uint32' },
      { name: 'c', type: 'uint8' },
    ],
  }));
  assert.deepEqual(l.rows.map((r) => r.offset), [0, 1, 5]);
  assert.equal(l.size, 6);
  assert.equal(l.align, 1);
  assert.equal(l.paddingBytes, 0);
});

test('pack(4): a uint32 after a uint8 gets 3 bytes of padding + tail padding', () => {
  const l = computeLayout(d({
    packing: 4,
    fields: [
      { name: 'a', type: 'uint8' },
      { name: 'b', type: 'uint32' },
      { name: 'c', type: 'uint8' },
    ],
  }));
  assert.deepEqual(l.rows.map((r) => r.offset), [0, 4, 8]);
  assert.equal(l.size, 12); // 9 rounded up to align 4
  assert.equal(l.align, 4);
  assert.equal(l.paddingBytes, 3 + 3);
});

test('pack(8): double aligns to 8', () => {
  const l = computeLayout(d({
    packing: 8,
    fields: [
      { name: 'tag', type: 'uint8' },
      { name: 'v', type: 'float64' },
    ],
  }));
  assert.deepEqual(l.rows.map((r) => r.offset), [0, 8]);
  assert.equal(l.size, 16);
  assert.equal(l.align, 8);
});

test('pack(2): alignment is capped at 2', () => {
  const l = computeLayout(d({
    packing: 2,
    fields: [
      { name: 'a', type: 'uint8' },
      { name: 'b', type: 'uint32' },
      { name: 'c', type: 'uint8' },
    ],
  }));
  assert.deepEqual(l.rows.map((r) => r.offset), [0, 2, 6]);
  assert.equal(l.size, 8);
  assert.equal(l.align, 2);
});

test('char / bytes arrays have alignment 1', () => {
  const l = computeLayout(d({
    packing: 4,
    fields: [
      { name: 'name', type: 'char[5]' },
      { name: 'blob', type: 'bytes', size: 2 },
      { name: 'x', type: 'uint32' },
    ],
  }));
  assert.deepEqual(l.rows.map((r) => r.offset), [0, 5, 8]);
  assert.equal(l.rows[0].cType, 'char');
  assert.equal(l.rows[0].cArraySuffix, '[5]');
  assert.equal(l.rows[1].cType, 'uint8_t');
  assert.equal(l.size, 12);
});

test('nested reusable struct: Vec3 under pack(4)', () => {
  const design = d({
    packing: 4,
    structs: {
      Vec3: { fields: [
        { name: 'x', type: 'float32' },
        { name: 'y', type: 'float32' },
        { name: 'z', type: 'float32' },
      ] },
    },
    fields: [
      { name: 'tag', type: 'uint8' },
      { name: 'v', type: 'Vec3' },
      { name: 'arr', type: 'Vec3[2]' },
    ],
  });
  const l = computeLayout(design);
  assert.deepEqual(l.rows.map((r) => r.offset), [0, 4, 16]);
  assert.equal(l.rows[1].size, 12);
  assert.equal(l.rows[2].size, 24);
  assert.equal(l.align, 4);
  assert.equal(l.size, 40);
});

test('bitfield occupies exactly its container size', () => {
  const l = computeLayout(d({
    packing: 1,
    fields: [
      { name: 'flags', type: 'uint8', bits: [
        { name: 'a', width: 1 },
        { name: 'b', width: 3 },
        { name: 'c', width: 4 },
      ] },
      { name: 'next', type: 'uint8' },
    ],
  }));
  assert.deepEqual(l.rows.map((r) => r.offset), [0, 1]);
  assert.equal(l.rows[0].size, 1);
  assert.equal(l.size, 2);
});

test('array.countField sizes from the referenced value', () => {
  const l = computeLayout(d({
    packing: 2,
    fields: [
      { name: 'n', type: 'uint8', value: 3 },
      { name: 'items', type: 'uint16', array: { countField: 'n' } },
    ],
  }));
  assert.deepEqual(l.rows.map((r) => r.offset), [0, 2]);
  assert.equal(l.rows[1].size, 6);
  assert.equal(l.rows[1].note, 'dynamic: count = n');
  assert.equal(l.size, 8);
});

test('explicit offset inserts padding', () => {
  const l = computeLayout(d({
    packing: 1,
    fields: [
      { name: 'a', type: 'uint8' },
      { name: 'b', type: 'uint8', offset: 8 },
    ],
  }));
  assert.deepEqual(l.rows.map((r) => r.offset), [0, 8]);
  assert.equal(l.paddingBytes, 7);
  assert.equal(l.size, 9);
});

test('multi-dimensional shorthand array', () => {
  const l = computeLayout(d({
    packing: 1,
    fields: [{ name: 'grid', type: 'int16[4][3]' }],
  }));
  assert.equal(l.rows[0].size, 4 * 3 * 2);
  assert.equal(l.rows[0].cArraySuffix, '[4][3]');
  assert.equal(l.size, 24);
});
