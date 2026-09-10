import assert from 'node:assert/strict';
import {
  validateIdentifier,
  sanitizeIdentifier,
  toUpperSnake,
  findDuplicates,
  uniquify,
} from '../../src/core/identifiers';

test('accepts ordinary identifiers', () => {
  for (const name of ['sample_count', 'x', 'Vec3', '_internal', 'a1b2', 'MAX_LEN']) {
    assert.equal(validateIdentifier(name, 'field').ok, true, name);
  }
});

test('rejects empty / whitespace / digit-first', () => {
  assert.equal(validateIdentifier('', 'field').ok, false);
  assert.equal(validateIdentifier('  ', 'field').ok, false);
  assert.equal(validateIdentifier('has space', 'field').ok, false);
  assert.equal(validateIdentifier('3d', 'field').ok, false);
  assert.equal(validateIdentifier('3d', 'field').suggestion, '_3d');
});

test('rejects invalid characters with a sanitized suggestion', () => {
  const r = validateIdentifier('foo-bar.baz', 'field');
  assert.equal(r.ok, false);
  assert.equal(r.suggestion, 'foo_bar_baz');
});

test('rejects C / C++ keywords and stdint typedefs', () => {
  for (const kw of ['int', 'struct', 'return', 'class', 'new', 'private', 'uint8_t', 'size_t', 'wchar_t']) {
    const r = validateIdentifier(kw, 'field');
    assert.equal(r.ok, false, kw);
    assert.equal(r.suggestion, kw + '_');
  }
});

test('rejects reserved _Upper prefix and double underscore', () => {
  assert.equal(validateIdentifier('_Foo', 'field').ok, false);
  assert.equal(validateIdentifier('_X', 'struct').ok, false);
  assert.equal(validateIdentifier('a__b', 'field').ok, false);
  assert.equal(validateIdentifier('foo__', 'field').ok, false);
});

test('unicode letters are not valid C identifiers', () => {
  assert.equal(validateIdentifier('café', 'field').ok, false);
  assert.equal(validateIdentifier('Ω', 'field').ok, false);
  assert.equal(validateIdentifier('naïve_flag', 'field').ok, false);
});

test('constants / enum labels: valid but hinted toward UPPER_SNAKE', () => {
  const r = validateIdentifier('maxLen', 'constant');
  assert.equal(r.ok, true);
  assert.equal(r.suggestion, 'MAX_LEN');
  assert.equal(validateIdentifier('MAX_LEN', 'constant').ok, true);
  assert.equal(validateIdentifier('MAX_LEN', 'constant').message, undefined);
});

test('sanitizeIdentifier normalizes aggressively', () => {
  assert.equal(sanitizeIdentifier('foo bar'), 'foo_bar');
  assert.equal(sanitizeIdentifier('3things'), '_3things');
  assert.equal(sanitizeIdentifier('a---b---c'), 'a_b_c');
  assert.equal(sanitizeIdentifier('__init__'), '_init_');
  assert.equal(sanitizeIdentifier('_Foo'), '_foo');
  assert.equal(sanitizeIdentifier('return'), 'return_');
  assert.equal(sanitizeIdentifier(''), 'x');
  assert.equal(sanitizeIdentifier('***'), 'x');
});

test('toUpperSnake', () => {
  assert.equal(toUpperSnake('sampleCount'), 'SAMPLE_COUNT');
  assert.equal(toUpperSnake('Vec3Reading'), 'VEC3_READING');
  assert.equal(toUpperSnake('already_snake'), 'ALREADY_SNAKE');
  assert.equal(toUpperSnake('kebab-case-thing'), 'KEBAB_CASE_THING');
});

test('collision helpers', () => {
  assert.deepEqual(findDuplicates(['a', 'b', 'a', 'c', 'b', 'b']).sort(), ['a', 'b']);
  assert.equal(uniquify('name', new Set(['name', 'name_2'])), 'name_3');
  assert.equal(uniquify('fresh', new Set(['name'])), 'fresh');
});
