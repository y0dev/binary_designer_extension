/**
 * Scalar type tables + type-string parsing.
 *
 * `type` on a Field is one of:
 *   - a scalar keyword
 *   - a struct name from `design.structs`
 *   - the literal `"struct"` (inline `fields`) or `"array"` (`array` + `items`)
 *   - shorthand: `<base>[<n>]` possibly chained, e.g. `int16[4][3]`
 */

export type ScalarKind = 'int' | 'float' | 'char' | 'bytes';

export interface ScalarInfo {
  /** canonical design keyword */
  key: string;
  size: number;
  signed: boolean;
  kind: ScalarKind;
  /** C member type without array suffix */
  cType: string;
}

const S = (key: string, size: number, signed: boolean, kind: ScalarKind, cType: string): ScalarInfo =>
  ({ key, size, signed, kind, cType });

export const SCALARS: Record<string, ScalarInfo> = {
  uint8: S('uint8', 1, false, 'int', 'uint8_t'),
  int8: S('int8', 1, true, 'int', 'int8_t'),
  uint16: S('uint16', 2, false, 'int', 'uint16_t'),
  int16: S('int16', 2, true, 'int', 'int16_t'),
  uint32: S('uint32', 4, false, 'int', 'uint32_t'),
  int32: S('int32', 4, true, 'int', 'int32_t'),
  uint64: S('uint64', 8, false, 'int', 'uint64_t'),
  int64: S('int64', 8, true, 'int', 'int64_t'),
  float32: S('float32', 4, true, 'float', 'float'),
  float64: S('float64', 8, true, 'float', 'double'),
  char: S('char', 1, true, 'char', 'char'),
};

/** type keyword aliases */
export const TYPE_ALIASES: Record<string, string> = {
  float: 'float32',
  double: 'float64',
  u8: 'uint8', i8: 'int8',
  u16: 'uint16', i16: 'int16',
  u32: 'uint32', i32: 'int32',
  u64: 'uint64', i64: 'int64',
  f32: 'float32', f64: 'float64',
};

/** Sized opaque/string types: need an explicit `size` (byte length). */
export const SIZED_TYPES = new Set(['bytes', 'padding', 'ascii', 'utf8', 'utf16']);

export const SCALAR_KEYWORDS = Object.keys(SCALARS);
export const ALL_TYPE_KEYWORDS = [
  ...SCALAR_KEYWORDS,
  ...Object.keys(TYPE_ALIASES),
  ...SIZED_TYPES,
  'struct',
  'array',
];

export function canonicalScalar(name: string): string {
  return TYPE_ALIASES[name] ?? name;
}

export function isScalar(name: string): boolean {
  return canonicalScalar(name) in SCALARS;
}

export function scalarInfo(name: string): ScalarInfo | undefined {
  return SCALARS[canonicalScalar(name)];
}

export interface ParsedType {
  /** base type keyword or struct name, with all `[n]` suffixes removed */
  base: string;
  /** array dimensions, outermost first: `int16[4][3]` -> [4, 3] */
  dims: number[];
  /** true if any dimension was parsed (i.e. shorthand array) */
  isArray: boolean;
}

const SHORTHAND_RE = /^([A-Za-z_][A-Za-z0-9_]*)((?:\[\s*\d+\s*\])*)$/;

/**
 * Parse a `type` string into `{ base, dims }`.
 * Throws on malformed shorthand (e.g. `int16[]`, `int16[-1]`, `int16[x]`).
 */
export function parseType(type: string): ParsedType {
  const raw = (type ?? '').trim();
  const m = SHORTHAND_RE.exec(raw);
  if (!m) {
    throw new Error(`malformed type string: "${type}"`);
  }
  const base = canonicalScalar(m[1]);
  const dims: number[] = [];
  const suffix = m[2];
  const dimRe = /\[\s*(\d+)\s*\]/g;
  let dm: RegExpExecArray | null;
  while ((dm = dimRe.exec(suffix)) !== null) {
    const n = Number(dm[1]);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`invalid array dimension in "${type}"`);
    }
    dims.push(n);
  }
  return { base, dims, isArray: dims.length > 0 };
}

export function productOf(dims: number[]): number {
  return dims.reduce((a, b) => a * b, 1);
}

/** `[4,3]` -> `"[4][3]"`, `[]` -> `""` */
export function cArraySuffix(dims: number[]): string {
  return dims.map((d) => `[${d}]`).join('');
}
