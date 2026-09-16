import assert from 'node:assert/strict';
import { computeLayout, effectiveAlign, structSummaries } from '../../src/core/layout';
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
  assert.equal(l.rows[0].elemSize, 2);
  assert.equal(l.rows[0].elemCount, 12);
  assert.equal(l.size, 24);
});

test('rows carry element size / count and a struct tag', () => {
  const design = d({
    packing: 1,
    structs: { Vec3: { fields: [
      { name: 'x', type: 'float32' }, { name: 'y', type: 'float32' }, { name: 'z', type: 'float32' },
    ] } },
    fields: [
      { name: 'head', type: 'uint32' },
      { name: 'pts', type: 'Vec3[64]' },
      { name: 'here', type: 'struct', fields: [{ name: 'a', type: 'uint8' }, { name: 'b', type: 'uint16' }] },
    ],
  });
  const l = computeLayout(design);
  assert.equal(l.rows[0].elemSize, 4);
  assert.equal(l.rows[0].elemCount, 1);
  assert.equal(l.rows[0].structTag, undefined);

  assert.equal(l.rows[1].elemSize, 12); // one Vec3
  assert.equal(l.rows[1].elemCount, 64);
  assert.equal(l.rows[1].size, 768);
  assert.equal(l.rows[1].structTag, 'Vec3');

  assert.equal(l.rows[2].elemSize, 3);
  assert.equal(l.rows[2].structTag, 'T_here');
});

test('structSummaries lists reusable and inline structs with their sizes', () => {
  const design = d({
    packing: 1,
    structs: {
      Vec3: { fields: [
        { name: 'x', type: 'float32' }, { name: 'y', type: 'float32' }, { name: 'z', type: 'float32' },
      ] },
      Pair: { fields: [{ name: 'lo', type: 'uint16' }, { name: 'hi', type: 'uint16' }] },
    },
    fields: [
      { name: 'v', type: 'Vec3' },
      { name: 'hdr', type: 'struct', fields: [{ name: 'kind', type: 'uint8' }, { name: 'len', type: 'uint16' }] },
    ],
  });
  const s = structSummaries(design);
  const byName = Object.fromEntries(s.map((x) => [x.name, x]));
  assert.equal(byName['Vec3'].size, 12);
  assert.equal(byName['Vec3'].reusable, true);
  assert.equal(byName['Vec3'].fieldCount, 3);
  assert.equal(byName['Pair'].size, 4);
  assert.equal(byName['T_hdr'].size, 3);
  assert.equal(byName['T_hdr'].reusable, false);
});

test('effectiveAlign: disabled packing (false) never caps, a number always does', () => {
  assert.equal(effectiveAlign(false, 8), 8);
  assert.equal(effectiveAlign(false, 1), 1);
  assert.equal(effectiveAlign(4, 8), 4);
  assert.equal(effectiveAlign(1, 8), 1);
  assert.equal(effectiveAlign(8, 4), 4);
});

test('packing: false gives natural alignment, distinct from any fixed packing value', () => {
  const fields: Design['fields'] = [
    { name: 'a', type: 'uint8' },
    { name: 'b', type: 'float64' },
  ];
  const natural = computeLayout(d({ packing: false, fields }));
  assert.deepEqual(natural.rows.map((r) => r.offset), [0, 8]); // float64 wants 8-byte alignment, uncapped
  assert.equal(natural.align, 8);
  assert.equal(natural.size, 16);

  const packed4 = computeLayout(d({ packing: 4, fields }));
  assert.deepEqual(packed4.rows.map((r) => r.offset), [0, 4]); // capped to 4
  assert.equal(packed4.align, 4);
  assert.equal(packed4.size, 12);

  const packed1 = computeLayout(d({ packing: 1, fields }));
  assert.deepEqual(packed1.rows.map((r) => r.offset), [0, 1]);
  assert.equal(packed1.size, 9);
});

test('packing: false still packs bytes/char/strings at alignment 1', () => {
  const l = computeLayout(d({
    packing: false,
    fields: [
      { name: 'tag', type: 'char[3]' },
      { name: 'n', type: 'uint32' },
    ],
  }));
  assert.deepEqual(l.rows.map((r) => r.offset), [0, 4]); // uint32 still naturally aligns to 4
  assert.equal(l.size, 8);
});

test('packing: false propagates through nested reusable structs', () => {
  const design = d({
    packing: false,
    structs: { Pair: { fields: [{ name: 'a', type: 'uint8' }, { name: 'b', type: 'float64' }] } },
    fields: [{ name: 'tag', type: 'uint8' }, { name: 'p', type: 'Pair' }],
  });
  const l = computeLayout(design);
  // Pair itself is naturally aligned (0, 8 -> size 16, align 8); as a member it
  // then aligns to 8 too, not to 1.
  assert.equal(l.rows[1].offset, 8);
  assert.equal(l.rows[1].size, 16);
});
