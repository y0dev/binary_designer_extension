import assert from 'node:assert/strict';
import { validateDesign } from '../../src/core/validate';
import { computeLayout } from '../../src/core/layout';
import { emitBinary } from '../../src/core/emitBinary';
import { roundTripCheck } from '../../src/core/parseBinary';
import { generateHeader } from '../../src/core/emitHeader';
import { Design } from '../../src/core/types';

function design(fields: Design['fields']): Design {
  return { name: 'R', endianness: 'little', packing: 1, fields };
}

test('a reserved field validates and keeps its size/offset', () => {
  const d = design([
    { name: 'head', type: 'uint32', value: 1 },
    { name: 'reserved0', type: 'uint16', reserved: true },
    { name: 'reserved1', type: 'bytes', size: 8, reserved: true, description: 'future use' },
    { name: 'tail', type: 'uint8', value: 2 },
  ]);
  const v = validateDesign(d);
  assert.equal(v.ok, true, JSON.stringify(v.errors));

  const l = computeLayout(d);
  assert.deepEqual(l.rows.map((r) => r.offset), [0, 4, 6, 14]);
  assert.equal(l.size, 15);
  assert.equal(l.rows[1].reserved, true);
  assert.equal(l.rows[2].reserved, true);
  assert.match(l.rows[1].note ?? '', /reserved/);
});

test('"reserved" must be a boolean', () => {
  const v = validateDesign(design([{ name: 'x', type: 'uint8', reserved: 'yes' as unknown as boolean }]));
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.path.endsWith('.reserved')));
});

test('an empty reserved field is zero-filled and NOT reported as defaulted', () => {
  const d = design([
    { name: 'a', type: 'uint32', value: 0x11223344 },
    { name: 'rsv', type: 'bytes', size: 4, reserved: true },
    { name: 'b', type: 'uint16' }, // genuinely defaulted
  ]);
  const emit = emitBinary(d);
  assert.deepEqual([...emit.bytes.subarray(4, 8)], [0, 0, 0, 0]);
  assert.deepEqual(emit.defaulted, ['b']); // 'rsv' is intentional, not a fallback
  assert.equal(roundTripCheck(d, emit).ok, true);
});

test('a reserved field still honors an explicit fill value', () => {
  const d = design([
    { name: 'rsv', type: 'bytes', size: 3, reserved: true, value: '0xffffff' },
  ]);
  const emit = emitBinary(d);
  assert.deepEqual([...emit.bytes], [0xff, 0xff, 0xff]);
  assert.equal(emit.defaulted.length, 0);
});

test('the C header annotates reserved members', () => {
  const d = design([
    { name: 'v', type: 'uint32', value: 0 },
    { name: 'reserved0', type: 'uint16', reserved: true },
    { name: 'reserved1', type: 'bytes', size: 8, reserved: true, description: 'future fields' },
  ]);
  const { header } = generateHeader(d, { staticAssert: true });
  assert.match(header, /uint16_t\s+reserved0;\s+\/\* reserved — do not use \*\//);
  assert.match(header, /uint8_t\s+reserved1\[8\];\s+\/\* reserved — future fields \*\//);
  assert.match(header, /_Static_assert\(sizeof\(R\) == 14,/);
});
