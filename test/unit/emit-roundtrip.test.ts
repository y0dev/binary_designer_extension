import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { emitBinary } from '../../src/core/emitBinary';
import { roundTripCheck, parseBinary } from '../../src/core/parseBinary';
import { parseDesignJson } from '../../src/core/index';
import { computeLayout } from '../../src/core/layout';
import { Design } from '../../src/core/types';

function rt(design: Design) {
  const emit = emitBinary(design);
  const check = roundTripCheck(design, emit);
  assert.equal(check.ok, true, JSON.stringify(check.mismatches.slice(0, 10)));
  return emit;
}

test('every scalar type round-trips, both endiannesses', () => {
  for (const endianness of ['little', 'big'] as const) {
    rt({
      name: 'S', endianness, packing: 1,
      fields: [
        { name: 'u8', type: 'uint8', value: 0xab },
        { name: 'i8', type: 'int8', value: -7 },
        { name: 'u16', type: 'uint16', value: 0x1234 },
        { name: 'i16', type: 'int16', value: -1000 },
        { name: 'u32', type: 'uint32', value: 0xdeadbeef },
        { name: 'i32', type: 'int32', value: -123456 },
        { name: 'u64', type: 'uint64', value: '0x0102030405060708' },
        { name: 'i64', type: 'int64', value: -1 },
        { name: 'f32', type: 'float32', value: 1.5 },
        { name: 'f64', type: 'float64', value: 3.141592653589793 },
      ],
    });
  }
});

test('magic constant is resolved and written little-endian', () => {
  const emit = rt({
    name: 'M', endianness: 'little', packing: 1,
    constants: { MAGIC: '0x46524d31' },
    fields: [{ name: 'magic', type: 'uint32', value: 'MAGIC' }],
  });
  assert.deepEqual([...emit.bytes], [0x31, 0x4d, 0x52, 0x46]);
});

test('ramp / repeat / const expressions expand deterministically', () => {
  const emit = rt({
    name: 'E', endianness: 'little', packing: 1,
    fields: [
      { name: 'ramp', type: 'int8[4]', value: ['ramp', -2, 2] },
      { name: 'rep', type: 'uint8[5]', value: ['repeat', 1, 2] },
      { name: 'k', type: 'uint8[3]', value: ['const', 9] },
    ],
  });
  assert.deepEqual([...emit.bytes.subarray(0, 4)], [0xfe, 0x00, 0x02, 0x04]);
  assert.deepEqual([...emit.bytes.subarray(4, 9)], [1, 2, 1, 2, 1]);
  assert.deepEqual([...emit.bytes.subarray(9, 12)], [9, 9, 9]);
});

test('strings: char[N] is NUL-padded and round-trips trimmed', () => {
  const design: Design = {
    name: 'Str', endianness: 'little', packing: 1,
    fields: [{ name: 'label', type: 'char[8]', value: 'hi' }],
  };
  const emit = rt(design);
  assert.deepEqual([...emit.bytes], [0x68, 0x69, 0, 0, 0, 0, 0, 0]);
  const parsed = parseBinary(design, emit.bytes);
  assert.equal(parsed.values.label, 'hi');
});

test('bitfields pack LSB-first and round-trip per slice', () => {
  const design: Design = {
    name: 'B', endianness: 'little', packing: 1,
    fields: [{
      name: 'flags', type: 'uint8',
      value: { enabled: 1, mode: 2, reserved: 0 },
      bits: [
        { name: 'enabled', width: 1 },
        { name: 'mode', width: 3 },
        { name: 'reserved', width: 4 },
      ],
    }],
  };
  const emit = rt(design);
  assert.equal(emit.bytes[0], 0b0000_0101);
});

test('nested struct arrays with per-element object values', () => {
  const design: Design = {
    name: 'N', endianness: 'little', packing: 1,
    structs: { Vec3: { fields: [
      { name: 'x', type: 'float32' },
      { name: 'y', type: 'float32' },
      { name: 'z', type: 'float32' },
    ] } },
    fields: [{
      name: 'pts', type: 'Vec3[3]',
      value: ['repeat', { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }],
    }],
  };
  const emit = rt(design);
  const parsed = parseBinary(design, emit.bytes) as unknown as { values: { pts: Array<Record<string, number>> } };
  assert.equal(parsed.values.pts[0].x, 1);
  assert.equal(parsed.values.pts[1].y, 1);
  assert.equal(parsed.values.pts[2].z, 1);
});

test('length-prefixed array: count field is written then that many elements', () => {
  const design: Design = {
    name: 'L', endianness: 'little', packing: 1,
    fields: [
      { name: 'n', type: 'uint8', value: 3 },
      { name: 'vals', type: 'uint16', array: { countField: 'n' }, value: ['ramp', 10, 5] },
    ],
  };
  const emit = rt(design);
  assert.equal(emit.size, 1 + 3 * 2);
  assert.deepEqual([...emit.bytes], [3, 10, 0, 15, 0, 20, 0]);
});

test('SensorFrame example round-trips, matches its computed size, keeps its magic', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'examples', 'SensorFrame.design.json'),
    'utf8',
  );
  const design = parseDesignJson(src);
  const emit = rt(design);
  assert.equal(emit.size, computeLayout(design).size);
  // 'FRM1' magic, little-endian
  assert.deepEqual([...emit.bytes.subarray(0, 4)], [0x31, 0x4d, 0x52, 0x46]);
});
