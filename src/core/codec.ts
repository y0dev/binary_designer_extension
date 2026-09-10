/**
 * Low-level scalar read/write + per-field "element plan" resolution shared by
 * the binary emitter and the round-trip parser.
 */

import { Design, Endianness, Field } from './types';
import {
  SIZED_TYPES,
  canonicalScalar,
  isScalar,
  parseType,
  scalarInfo,
} from './typeUtil';
import { layoutFieldList } from './layout';

export type PlanKind =
  | 'scalar'
  | 'blob-bytes'
  | 'blob-string'
  | 'struct'
  | 'bitfield';

export interface ElementPlan {
  kind: PlanKind;
  /** repetition dimensions (outermost first); [] = a single element */
  dims: number[];
  /** dynamic outer dim source (array.countField) */
  dynamicOuter?: string;
  /** bytes for one element */
  elemSize: number;
  endianness: Endianness;

  /** kind === 'scalar' | 'bitfield' */
  scalarType?: string;
  /** kind === 'blob-string' */
  strType?: 'char' | 'ascii' | 'utf8' | 'utf16';
  /** kind === 'blob-string' | 'blob-bytes': bytes in one blob element */
  blobBytes?: number;

  /** kind === 'struct' */
  structFields?: Field[];
  structName?: string;

  /** kind === 'bitfield' */
  bits?: NonNullable<Field['bits']>;
}

export function elementCount(dims: number[]): number {
  return dims.reduce((a, b) => a * b, 1);
}

/**
 * Resolve how a field's element(s) are encoded. `resolveCount` maps an earlier
 * sibling field name to its (numeric) design-time value, for `array.countField`.
 */
export function planField(
  field: Field,
  design: Design,
  resolveCount: (name: string) => number,
  parentName: string,
): ElementPlan {
  const endianness: Endianness = field.endianness ?? design.endianness ?? 'little';

  // nested array wrapper
  if (field.type === 'array' || (field.array && field.items)) {
    const a = field.array ?? {};
    let outer: number;
    let dynamicOuter: string | undefined;
    if (a.countField) {
      dynamicOuter = a.countField;
      outer = resolveCount(a.countField);
    } else {
      outer = a.count ?? 0;
    }
    if (!field.items) {
      throw new Error(`array field "${field.name}" has no "items"`);
    }
    const inner = planField(field.items, design, resolveCount, parentName);
    return {
      ...inner,
      dims: [outer, ...inner.dims],
      dynamicOuter: dynamicOuter ?? inner.dynamicOuter,
    };
  }

  const pt = parseType(field.type);
  const repDims: number[] = [];
  let dynamicOuter: string | undefined;
  if (field.array) {
    if (field.array.countField) {
      dynamicOuter = field.array.countField;
      repDims.push(resolveCount(field.array.countField));
    } else {
      repDims.push(field.array.count ?? 0);
    }
  }
  const base = pt.base;

  // bitfield
  if (field.bits && field.bits.length > 0) {
    const si = scalarInfo(base);
    if (!si || si.kind !== 'int') {
      throw new Error(`bitfield "${field.name}" needs an integer container type`);
    }
    return {
      kind: 'bitfield',
      dims: [...repDims, ...pt.dims],
      dynamicOuter,
      elemSize: si.size,
      endianness,
      scalarType: canonicalScalar(base),
      bits: field.bits,
    };
  }

  // sized opaque / string
  if (SIZED_TYPES.has(base)) {
    const n = field.size ?? 0;
    if (base === 'bytes' || base === 'padding') {
      return {
        kind: 'blob-bytes',
        dims: [...repDims, ...pt.dims],
        dynamicOuter,
        elemSize: n,
        blobBytes: n,
        endianness,
      };
    }
    return {
      kind: 'blob-string',
      dims: [...repDims, ...pt.dims],
      dynamicOuter,
      elemSize: n,
      blobBytes: n,
      strType: base as 'ascii' | 'utf8' | 'utf16',
      endianness,
    };
  }

  // scalar
  if (isScalar(base)) {
    if (base === 'char') {
      // char[N] is one N-byte NUL-padded string; trailing shorthand dim is the length
      let strLen: number;
      let reps = [...repDims];
      if (pt.dims.length >= 1) {
        strLen = pt.dims[pt.dims.length - 1];
        reps = [...repDims, ...pt.dims.slice(0, -1)];
      } else if (repDims.length >= 1) {
        strLen = repDims[repDims.length - 1];
        reps = repDims.slice(0, -1);
      } else {
        strLen = 1;
      }
      return {
        kind: 'blob-string',
        dims: reps,
        dynamicOuter,
        elemSize: strLen,
        blobBytes: strLen,
        strType: 'char',
        endianness,
      };
    }
    const si = scalarInfo(base)!;
    return {
      kind: 'scalar',
      dims: [...repDims, ...pt.dims],
      dynamicOuter,
      elemSize: si.size,
      endianness,
      scalarType: canonicalScalar(base),
    };
  }

  // inline struct
  if (base === 'struct' || field.type === 'struct') {
    const inlineFields = field.fields ?? [];
    const sub = layoutFieldList(design, inlineFields, `${parentName}_${field.name}`);
    return {
      kind: 'struct',
      dims: [...repDims, ...pt.dims],
      dynamicOuter,
      elemSize: sub.size,
      endianness,
      structFields: inlineFields,
    };
  }

  // named struct
  if (design.structs && design.structs[base]) {
    const sub = layoutFieldList(design, design.structs[base].fields, base);
    return {
      kind: 'struct',
      dims: [...repDims, ...pt.dims],
      dynamicOuter,
      elemSize: sub.size,
      endianness,
      structName: base,
      structFields: design.structs[base].fields,
    };
  }

  throw new Error(`field "${field.name}": unknown type "${field.type}"`);
}

// ---------------------------------------------------------------------------
// scalar codec
// ---------------------------------------------------------------------------

export function toBigInt(v: unknown): bigint {
  if (typeof v === 'bigint') {
    return v;
  }
  if (typeof v === 'number') {
    return BigInt(Math.trunc(v));
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^[+-]?0x[0-9a-f]+$/i.test(s)) {
      return BigInt(s);
    }
    if (/^[+-]?\d+$/.test(s)) {
      return BigInt(s);
    }
    return 0n;
  }
  return 0n;
}

export function writeScalar(
  dv: DataView,
  offset: number,
  scalarType: string,
  value: unknown,
  endianness: Endianness,
): void {
  const le = endianness === 'little';
  const num = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))
      ? Number(value)
      : Number(value ?? 0);
  switch (scalarType) {
    case 'uint8': dv.setUint8(offset, Number(toBigInt(value) & 0xffn)); return;
    case 'int8': dv.setInt8(offset, Number(BigInt.asIntN(8, toBigInt(value)))); return;
    case 'uint16': dv.setUint16(offset, Number(toBigInt(value) & 0xffffn), le); return;
    case 'int16': dv.setInt16(offset, Number(BigInt.asIntN(16, toBigInt(value))), le); return;
    case 'uint32': dv.setUint32(offset, Number(toBigInt(value) & 0xffffffffn), le); return;
    case 'int32': dv.setInt32(offset, Number(BigInt.asIntN(32, toBigInt(value))), le); return;
    case 'uint64': dv.setBigUint64(offset, BigInt.asUintN(64, toBigInt(value)), le); return;
    case 'int64': dv.setBigInt64(offset, BigInt.asIntN(64, toBigInt(value)), le); return;
    case 'float32': dv.setFloat32(offset, Number.isFinite(num) ? num : 0, le); return;
    case 'float64': dv.setFloat64(offset, Number.isFinite(num) ? num : 0, le); return;
    default: throw new Error(`writeScalar: unsupported type "${scalarType}"`);
  }
}

export function readScalar(
  dv: DataView,
  offset: number,
  scalarType: string,
  endianness: Endianness,
): number | bigint {
  const le = endianness === 'little';
  switch (scalarType) {
    case 'uint8': return dv.getUint8(offset);
    case 'int8': return dv.getInt8(offset);
    case 'uint16': return dv.getUint16(offset, le);
    case 'int16': return dv.getInt16(offset, le);
    case 'uint32': return dv.getUint32(offset, le);
    case 'int32': return dv.getInt32(offset, le);
    case 'uint64': return dv.getBigUint64(offset, le);
    case 'int64': return dv.getBigInt64(offset, le);
    case 'float32': return dv.getFloat32(offset, le);
    case 'float64': return dv.getFloat64(offset, le);
    default: throw new Error(`readScalar: unsupported type "${scalarType}"`);
  }
}

export function isSampleExpr(v: unknown): v is unknown[] {
  return (
    Array.isArray(v) &&
    v.length >= 1 &&
    typeof v[0] === 'string' &&
    ['const', 'ramp', 'repeat', 'random'].includes(v[0])
  );
}

/** mulberry32 — tiny deterministic PRNG. Returns a function yielding [0,1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Expand a sample expression / literal / scalar into exactly `n` element values.
 * `isFloat` picks the RNG range for `random`.
 */
export function expandValues(value: unknown, n: number, isFloat: boolean): unknown[] {
  if (isSampleExpr(value)) {
    const [op, ...args] = value as [string, ...unknown[]];
    if (op === 'const') {
      return new Array(n).fill(args[0] ?? 0);
    }
    if (op === 'ramp') {
      const start = Number(args[0] ?? 0);
      const step = args.length >= 2 ? Number(args[1]) : 1;
      return Array.from({ length: n }, (_v, i) => start + i * step);
    }
    if (op === 'repeat') {
      const vals = args.length ? args : [0];
      return Array.from({ length: n }, (_v, i) => vals[i % vals.length]);
    }
    if (op === 'random') {
      const rng = mulberry32(Number(args[0] ?? 1));
      return Array.from({ length: n }, () =>
        isFloat ? rng() : Math.floor(rng() * 256));
    }
  }
  if (Array.isArray(value)) {
    return Array.from({ length: n }, (_v, i) => value[i]);
  }
  // scalar -> repeated
  return new Array(n).fill(value);
}
