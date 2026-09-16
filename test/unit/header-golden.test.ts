import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { generateHeader } from '../../src/core/emitHeader';
import { parseDesignJson } from '../../src/core/index';
import { Design } from '../../src/core/types';

const root = path.resolve(__dirname, '..', '..', '..');

test('SensorFrame.h matches the checked-in golden file', () => {
  const src = fs.readFileSync(path.join(root, 'examples', 'SensorFrame.design.json'), 'utf8');
  const design = parseDesignJson(src);
  const { header } = generateHeader(design, {
    sourceFileName: 'SensorFrame.design.json',
    staticAssert: true,
    includeStyle: 'angle',
  });
  const golden = fs.readFileSync(path.join(root, 'examples', 'generated', 'SensorFrame.h'), 'utf8');
  assert.equal(header.replace(/\r\n/g, '\n'), golden.replace(/\r\n/g, '\n'));
});

test('SensorFrame_layout.md matches the checked-in golden file', () => {
  const src = fs.readFileSync(path.join(root, 'examples', 'SensorFrame.design.json'), 'utf8');
  const design = parseDesignJson(src);
  const { layoutDoc } = generateHeader(design, { sourceFileName: 'SensorFrame.design.json' });
  const golden = fs.readFileSync(path.join(root, 'examples', 'generated', 'SensorFrame_layout.md'), 'utf8');
  assert.equal(layoutDoc.replace(/\r\n/g, '\n'), golden.replace(/\r\n/g, '\n'));
});

test('inline struct becomes a <Parent>_<field> typedef', () => {
  const design: Design = {
    name: 'Packet', packing: 1, endianness: 'little',
    fields: [
      { name: 'head', type: 'struct', fields: [
        { name: 'kind', type: 'uint8' },
        { name: 'len', type: 'uint16' },
      ] },
      { name: 'crc', type: 'uint32' },
    ],
  };
  const { header } = generateHeader(design, { staticAssert: true });
  assert.match(header, /typedef struct Packet_head \{/);
  assert.match(header, /Packet_head\s+head;/);
  assert.match(header, /_Static_assert\(sizeof\(Packet\) == 7,/);
});

test('enum prelude + UPPER_SNAKE constants prefixed by the enclosing type', () => {
  const design: Design = {
    name: 'Dev', packing: 1, endianness: 'little',
    fields: [{ name: 'state', type: 'uint8', enum: { '0': 'idle', '1': 'busy' } }],
  };
  const plain = generateHeader(design, {}).header;
  assert.match(plain, /typedef enum Dev_state \{/);
  assert.match(plain, /DEV_STATE_IDLE\s+= 0,/);
  assert.match(plain, /DEV_STATE_BUSY\s+= 1/);
  assert.match(plain, /uint8_t\s+state;/); // field keeps its integer type by default

  const withTypedef = generateHeader(design, { enumTypedefForFields: true }).header;
  assert.match(withTypedef, /Dev_state\s+state;/);
});

test('array.countField: flexible array member when last, warning otherwise', () => {
  const lastFam = generateHeader({
    name: 'Msg', packing: 1, endianness: 'little',
    fields: [
      { name: 'n', type: 'uint16', value: 0 },
      { name: 'items', type: 'uint8', array: { countField: 'n' } },
    ],
  }, {});
  assert.match(lastFam.header, /uint8_t\s+items\[\];/);
  assert.equal(lastFam.warnings.length, 0);

  const notLast = generateHeader({
    name: 'Msg2', packing: 1, endianness: 'little',
    fields: [
      { name: 'n', type: 'uint16', value: 0 },
      { name: 'items', type: 'uint8', array: { countField: 'n' } },
      { name: 'crc', type: 'uint32' },
    ],
  }, {});
  assert.ok(notLast.warnings.some((w) => /arrayMax/.test(w)));

  const withMax = generateHeader({
    name: 'Msg3', packing: 1, endianness: 'little',
    fields: [
      { name: 'n', type: 'uint16', value: 0 },
      { name: 'items', type: 'uint8', array: { countField: 'n' } },
      { name: 'crc', type: 'uint32' },
    ],
  }, { arrayMax: 32 });
  assert.match(withMax.header, /uint8_t\s+items\[32\];/);
});

test('no-static-assert option omits the assertion', () => {
  const design: Design = { name: 'X', packing: 1, endianness: 'little', fields: [{ name: 'a', type: 'uint8' }] };
  assert.doesNotMatch(generateHeader(design, { staticAssert: false }).header, /_Static_assert/);
});

test('packing: false emits no #pragma pack and asserts the natural size', () => {
  const design: Design = {
    name: 'Natural', packing: false, endianness: 'little',
    fields: [
      { name: 'tag', type: 'uint8' },
      { name: 'value', type: 'float64' },
    ],
  };
  const { header } = generateHeader(design, {});
  assert.doesNotMatch(header, /#pragma pack\(/);
  assert.match(header, /packing disabled/);
  assert.match(header, /_Static_assert\(sizeof\(Natural\) == 16,/); // naturally aligned, not byte-packed
});

test('reusable structs are emitted in dependency order', () => {
  const design: Design = {
    name: 'Scene', packing: 1, endianness: 'little',
    structs: {
      Triangle: { fields: [{ name: 'a', type: 'Vec3' }, { name: 'b', type: 'Vec3' }, { name: 'c', type: 'Vec3' }] },
      Vec3: { fields: [{ name: 'x', type: 'float32' }, { name: 'y', type: 'float32' }, { name: 'z', type: 'float32' }] },
    },
    fields: [{ name: 't', type: 'Triangle' }],
  };
  const { header } = generateHeader(design, {});
  assert.ok(header.indexOf('} Vec3;') < header.indexOf('} Triangle;'), 'Vec3 must be defined before Triangle');
});
