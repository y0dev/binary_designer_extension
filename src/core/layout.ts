/**
 * The layout engine.
 *
 * Computes offset / size / alignment / padding for every top-level member of a
 * Design, following standard C struct-layout rules under `#pragma pack(N)`:
 *
 *   - a scalar's alignment is `min(packing, sizeof(scalar))`
 *   - `char` / `bytes` / `padding` / string members have alignment 1
 *   - an array has the alignment of its element
 *   - a struct has the alignment of its most-aligned member
 *   - each member starts at the next offset that is a multiple of its alignment
 *   - the struct's total size is rounded up to a multiple of the struct's alignment
 *
 * Pure. No `vscode`. Unit-tested against hand-computed `sizeof`/`offsetof`.
 */

import {
  Design,
  Endianness,
  Field,
  LayoutResult,
  LayoutRow,
  Packing,
} from './types';
import {
  SIZED_TYPES,
  cArraySuffix,
  isScalar,
  parseType,
  productOf,
  scalarInfo,
} from './typeUtil';

export function roundUp(value: number, align: number): number {
  const a = align < 1 ? 1 : align;
  return Math.ceil(value / a) * a;
}

export function parseNumericValue(
  v: unknown,
  constants?: Record<string, string | number>,
): number {
  if (typeof v === 'number') {
    return v;
  }
  if (typeof v === 'string') {
    if (constants && Object.prototype.hasOwnProperty.call(constants, v)) {
      return parseNumericValue(constants[v]);
    }
    const s = v.trim();
    if (/^[+-]?0x[0-9a-f]+$/i.test(s)) {
      return parseInt(s, 16);
    }
    if (/^[+-]?0b[01]+$/i.test(s)) {
      return parseInt(s.replace(/0b/i, ''), 2);
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

interface Shape {
  /** base C member type; `null` means "an inline struct — caller names it" */
  cType: string | null;
  cArraySuffix: string;
  dims: number[];
  dynamicOuter?: string;
  elemSize: number;
  align: number;
  totalSize: number;
  kind: 'scalar' | 'float' | 'char' | 'bytes' | 'string' | 'struct' | 'bitfield';
  structName?: string;
  inlineFields?: Field[];
  note?: string;
}

export interface LayoutContext {
  packing: Packing;
  endianness: Endianness;
  design: Design;
  /** guard against `structs` that reference themselves */
  visiting: Set<string>;
  cache: Map<string, LayoutResult>;
}

export function makeContext(design: Design, packingDefault: Packing = 1): LayoutContext {
  return {
    packing: (design.packing ?? packingDefault) as Packing,
    endianness: design.endianness ?? 'little',
    design,
    visiting: new Set(),
    cache: new Map(),
  };
}

/** Layout of a named reusable struct from `design.structs`. */
export function structLayout(ctx: LayoutContext, structName: string): LayoutResult {
  const cached = ctx.cache.get(structName);
  if (cached) {
    return cached;
  }
  const def = ctx.design.structs?.[structName];
  if (!def) {
    throw new Error(`unknown struct "${structName}"`);
  }
  if (ctx.visiting.has(structName)) {
    throw new Error(`recursive struct definition: "${structName}"`);
  }
  ctx.visiting.add(structName);
  const result = packFields(ctx, def.fields, structName);
  ctx.visiting.delete(structName);
  ctx.cache.set(structName, result);
  return result;
}

/** Layout of the top-level struct body. */
export function computeLayout(design: Design, packingDefault: Packing = 1): LayoutResult {
  const ctx = makeContext(design, packingDefault);
  return packFields(ctx, design.fields ?? [], design.name);
}

/** Layout of an arbitrary field list (inline struct body, etc.). */
export function layoutFieldList(
  design: Design,
  fields: Field[],
  parentName: string,
  packingDefault: Packing = 1,
): LayoutResult {
  return packFields(makeContext(design, packingDefault), fields, parentName);
}

function resolveShape(
  ctx: LayoutContext,
  field: Field,
  parentName: string,
  resolveCount: (name: string) => number,
): Shape {
  // ---- nested `array` wrapper (type:"array" + items, or array+items) ----
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
    const items = field.items;
    if (!items) {
      throw new Error(`array field "${field.name}" has no "items"`);
    }
    const inner = resolveShape(ctx, items, parentName, resolveCount);
    const dims = [outer, ...inner.dims];
    return {
      ...inner,
      dims,
      dynamicOuter: dynamicOuter ?? inner.dynamicOuter,
      cArraySuffix: cArraySuffix(dims),
      totalSize: inner.elemSize * productOf(dims),
      note: dynamicOuter ? `count = ${dynamicOuter}` : inner.note,
    };
  }

  const pt = parseType(field.type);
  const dims: number[] = [];
  let dynamicOuter: string | undefined;
  if (field.array) {
    if (field.array.countField) {
      dynamicOuter = field.array.countField;
      dims.push(resolveCount(field.array.countField));
    } else {
      dims.push(field.array.count ?? 0);
    }
  }
  dims.push(...pt.dims);
  const base = pt.base;

  // ---- bitfield container ----
  if (field.bits && field.bits.length > 0) {
    const si = scalarInfo(base);
    if (!si || si.kind !== 'int') {
      throw new Error(`bitfield "${field.name}" needs an integer container type, got "${field.type}"`);
    }
    const align = Math.min(ctx.packing, si.size);
    return {
      cType: si.cType,
      cArraySuffix: cArraySuffix(dims),
      dims,
      dynamicOuter,
      elemSize: si.size,
      align,
      totalSize: si.size * productOf(dims),
      kind: 'bitfield',
    };
  }

  // ---- sized opaque / string types ----
  if (SIZED_TYPES.has(base)) {
    const n = field.size ?? 0;
    if (base === 'bytes' || base === 'padding') {
      const d = [...dims, n];
      return {
        cType: 'uint8_t',
        cArraySuffix: cArraySuffix(d),
        dims: d,
        dynamicOuter,
        elemSize: 1,
        align: 1,
        totalSize: productOf(d),
        kind: 'bytes',
        note: base === 'padding' ? 'padding' : undefined,
      };
    }
    if (base === 'utf16') {
      const count = Math.ceil(n / 2);
      const d = [...dims, count];
      return {
        cType: 'uint16_t',
        cArraySuffix: cArraySuffix(d),
        dims: d,
        dynamicOuter,
        elemSize: 2,
        align: 1,
        totalSize: 2 * productOf(d),
        kind: 'string',
      };
    }
    // ascii / utf8
    const d = [...dims, n];
    return {
      cType: 'char',
      cArraySuffix: cArraySuffix(d),
      dims: d,
      dynamicOuter,
      elemSize: 1,
      align: 1,
      totalSize: productOf(d),
      kind: 'string',
    };
  }

  // ---- scalar ----
  if (isScalar(base)) {
    const si = scalarInfo(base)!;
    if (base === 'char') {
      return {
        cType: 'char',
        cArraySuffix: cArraySuffix(dims),
        dims,
        dynamicOuter,
        elemSize: 1,
        align: 1,
        totalSize: productOf(dims),
        kind: 'char',
      };
    }
    const align = Math.min(ctx.packing, si.size);
    return {
      cType: si.cType,
      cArraySuffix: cArraySuffix(dims),
      dims,
      dynamicOuter,
      elemSize: si.size,
      align,
      totalSize: si.size * productOf(dims),
      kind: si.kind === 'float' ? 'float' : 'scalar',
    };
  }

  // ---- inline struct ----
  if (base === 'struct' || field.type === 'struct') {
    const inlineFields = field.fields ?? [];
    const sub = packFields(ctx, inlineFields, `${parentName}_${field.name}`);
    return {
      cType: null,
      cArraySuffix: cArraySuffix(dims),
      dims,
      dynamicOuter,
      elemSize: sub.size,
      align: sub.align,
      totalSize: sub.size * productOf(dims),
      kind: 'struct',
      inlineFields,
    };
  }

  // ---- named struct ----
  if (ctx.design.structs && ctx.design.structs[base]) {
    const sub = structLayout(ctx, base);
    return {
      cType: base,
      cArraySuffix: cArraySuffix(dims),
      dims,
      dynamicOuter,
      elemSize: sub.size,
      align: sub.align,
      totalSize: sub.size * productOf(dims),
      kind: 'struct',
      structName: base,
    };
  }

  throw new Error(`field "${field.name}": unknown type "${field.type}"`);
}

function packFields(ctx: LayoutContext, fields: Field[], parentName: string): LayoutResult {
  let cursor = 0;
  let maxAlign = 1;
  let padding = 0;
  const rows: LayoutRow[] = [];
  const priorValues = new Map<string, number>();

  const resolveCount = (name: string): number => priorValues.get(name) ?? 0;

  for (const field of fields) {
    const shape = resolveShape(ctx, field, parentName, resolveCount);

    let offset: number;
    if (typeof field.offset === 'number') {
      offset = field.offset;
      if (offset < cursor) {
        // Overlap: validateDesign reports this as an error; here we just don't
        // rewind so the table stays monotonic.
        offset = cursor;
      }
    } else {
      offset = roundUp(cursor, shape.align);
    }
    padding += offset - cursor;

    let cType = shape.cType;
    if (cType === null) {
      cType = `${parentName}_${field.name}`;
    }

    const baseNote = shape.dynamicOuter
      ? `dynamic: count = ${shape.dynamicOuter}`
      : shape.note;
    rows.push({
      name: field.name,
      cType,
      cArraySuffix: shape.cArraySuffix,
      offset,
      size: shape.totalSize,
      align: shape.align,
      note: field.reserved
        ? baseNote ? `reserved; ${baseNote}` : 'reserved'
        : baseNote,
      reserved: field.reserved ? true : undefined,
    });

    cursor = offset + shape.totalSize;
    maxAlign = Math.max(maxAlign, shape.align);
    priorValues.set(field.name, parseNumericValue(field.value, ctx.design.constants));
  }

  const structAlign = Math.max(1, maxAlign);
  const total = roundUp(cursor, structAlign);
  padding += total - cursor;

  return {
    rows,
    size: total,
    align: structAlign,
    paddingBytes: padding,
    packing: ctx.packing,
    endianness: ctx.endianness,
  };
}
