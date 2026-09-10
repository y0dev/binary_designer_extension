/**
 * Identifier validation & normalization.
 *
 * Every `name` in a Design that becomes a C identifier — the design name,
 * struct keys, field names, enum labels, bit names, constants — must pass
 * {@link validateIdentifier}. Generators call it again, hard, and refuse to
 * run on invalid names.
 */

import { IdentifierCheck, IdentifierKind } from './types';

const ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** C89..C23 keywords. */
const C_KEYWORDS = [
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do',
  'double', 'else', 'enum', 'extern', 'float', 'for', 'goto', 'if', 'inline',
  'int', 'long', 'register', 'restrict', 'return', 'short', 'signed', 'sizeof',
  'static', 'struct', 'switch', 'typedef', 'union', 'unsigned', 'void',
  'volatile', 'while',
  '_Alignas', '_Alignof', '_Atomic', '_Bool', '_Complex', '_Decimal128',
  '_Decimal32', '_Decimal64', '_Generic', '_Imaginary', '_Noreturn',
  '_Static_assert', '_Thread_local',
  'alignas', 'alignof', 'bool', 'constexpr', 'false', 'nullptr', 'static_assert',
  'thread_local', 'true', 'typeof', 'typeof_unqual',
];

/** A few C++ keywords too, so headers stay usable from C++. */
const CPP_KEYWORDS = [
  'asm', 'catch', 'class', 'delete', 'explicit', 'export', 'friend', 'mutable',
  'namespace', 'new', 'operator', 'private', 'protected', 'public', 'template',
  'this', 'throw', 'try', 'typeid', 'typename', 'using', 'virtual', 'wchar_t',
  'and', 'and_eq', 'bitand', 'bitor', 'compl', 'not', 'not_eq', 'or', 'or_eq',
  'xor', 'xor_eq', 'char8_t', 'char16_t', 'char32_t', 'co_await', 'co_return',
  'co_yield', 'concept', 'consteval', 'constinit', 'decltype', 'noexcept',
  'reinterpret_cast', 'static_cast', 'dynamic_cast', 'const_cast', 'requires',
];

/** <stdint.h> / <stddef.h> / <stdbool.h> typedefs — reserved for our type map. */
const STDLIB_TYPES = [
  'int8_t', 'int16_t', 'int32_t', 'int64_t',
  'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
  'int_least8_t', 'int_least16_t', 'int_least32_t', 'int_least64_t',
  'uint_least8_t', 'uint_least16_t', 'uint_least32_t', 'uint_least64_t',
  'int_fast8_t', 'int_fast16_t', 'int_fast32_t', 'int_fast64_t',
  'uint_fast8_t', 'uint_fast16_t', 'uint_fast32_t', 'uint_fast64_t',
  'intptr_t', 'uintptr_t', 'intmax_t', 'uintmax_t',
  'size_t', 'ssize_t', 'ptrdiff_t', 'wchar_t', 'max_align_t', 'nullptr_t',
];

export const RESERVED_WORDS: ReadonlySet<string> = new Set([
  ...C_KEYWORDS,
  ...CPP_KEYWORDS,
  ...STDLIB_TYPES,
]);

const KIND_LABEL: Record<IdentifierKind, string> = {
  design: 'design name',
  struct: 'struct name',
  field: 'field name',
  enumLabel: 'enum label',
  bitName: 'bit name',
  constant: 'constant name',
};

/**
 * Turn an arbitrary string into a valid C identifier.
 * - non `[A-Za-z0-9_]` runs collapse to a single `_`
 * - leading digit gets a `_` prefix
 * - `__` runs collapse to `_`
 * - leading `_` followed by uppercase is de-capitalized
 * - empty -> `x`
 * - reserved words get a trailing `_`
 */
export function sanitizeIdentifier(input: string): string {
  let s = (input ?? '').trim();
  s = s.replace(/[^A-Za-z0-9_]+/g, '_');
  s = s.replace(/_+/g, '_');
  s = s.replace(/^_+(?=[A-Za-z0-9])/, '_'); // keep at most one leading underscore
  if (/^[0-9]/.test(s)) {
    s = '_' + s;
  }
  s = s.replace(/^_([A-Z])/, (_m, c: string) => '_' + c.toLowerCase());
  s = s.replace(/__+/g, '_');
  if (s === '' || s === '_') {
    s = 'x';
  }
  if (RESERVED_WORDS.has(s)) {
    s = s + '_';
  }
  return s;
}

/** camelCase / PascalCase / kebab / spaces -> UPPER_SNAKE_CASE. */
export function toUpperSnake(input: string): string {
  let s = (input ?? '').trim();
  s = s.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  s = s.replace(/[^A-Za-z0-9]+/g, '_');
  s = s.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  s = s.toUpperCase();
  if (s === '' ) {
    s = 'X';
  }
  if (/^[0-9]/.test(s)) {
    s = '_' + s;
  }
  return s;
}

/**
 * Validate a single identifier.
 *
 * @param name the raw string from the design
 * @param kind what the identifier is used for (drives messaging & normalization)
 */
export function validateIdentifier(name: string, kind: IdentifierKind): IdentifierCheck {
  const label = KIND_LABEL[kind];

  if (name === undefined || name === null || name === '') {
    return { ok: false, message: `${label} is empty`, suggestion: kind === 'field' ? 'field' : 'name' };
  }
  if (typeof name !== 'string') {
    return { ok: false, message: `${label} must be a string`, suggestion: 'name' };
  }
  if (/\s/.test(name)) {
    return {
      ok: false,
      message: `${label} "${name}" contains whitespace`,
      suggestion: sanitizeIdentifier(name),
    };
  }
  if (/^[0-9]/.test(name)) {
    return {
      ok: false,
      message: `${label} "${name}" starts with a digit`,
      suggestion: sanitizeIdentifier(name),
    };
  }
  if (!ID_RE.test(name)) {
    return {
      ok: false,
      message: `${label} "${name}" is not a valid C identifier (allowed: letters, digits, underscore; no leading digit)`,
      suggestion: sanitizeIdentifier(name),
    };
  }
  if (RESERVED_WORDS.has(name)) {
    return {
      ok: false,
      message: `${label} "${name}" is a reserved C/C++ keyword or standard typedef`,
      suggestion: sanitizeIdentifier(name),
    };
  }
  if (/^_[A-Z]/.test(name)) {
    return {
      ok: false,
      message: `${label} "${name}" starts with "_" + uppercase, which is reserved for the C implementation`,
      suggestion: sanitizeIdentifier(name),
    };
  }
  if (name.includes('__')) {
    return {
      ok: false,
      message: `${label} "${name}" contains "__", which is reserved for the C implementation`,
      suggestion: sanitizeIdentifier(name),
    };
  }

  // Soft hint for constants / enum labels: prefer UPPER_SNAKE_CASE.
  if ((kind === 'constant' || kind === 'enumLabel') && name !== name.toUpperCase()) {
    return {
      ok: true,
      message: `${label} "${name}" is valid, but UPPER_SNAKE_CASE is conventional for C macros/enum constants`,
      suggestion: toUpperSnake(name),
    };
  }

  return { ok: true };
}

/**
 * Check a whole set of sibling identifiers for uniqueness (case-sensitive).
 * Returns the names that collide (2nd+ occurrence).
 */
export function findDuplicates(names: string[]): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) {
      dups.add(n);
    }
    seen.add(n);
  }
  return [...dups];
}

/** De-duplicate a name against a set of already-used names by appending `_2`, `_3`, ... */
export function uniquify(name: string, used: ReadonlySet<string>): string {
  if (!used.has(name)) {
    return name;
  }
  let i = 2;
  while (used.has(`${name}_${i}`)) {
    i++;
  }
  return `${name}_${i}`;
}
