/**
 * Round-trip parser.
 *
 * Re-reads a buffer against the design and produces (a) a structured value tree
 * and (b) the same flat "canonical string per leaf" map the emitter produces, so
 * {@link roundTripCheck} can assert every field reads back what was written.
 */

import { Design } from './types';
import { computeLayout, layoutFieldList } from './layout';
import { ElementPlan, elementCount, planField, readScalar, toBigInt } from './codec';
import { scalarInfo } from './typeUtil';

export interface ParseResult {
  values: Record<string, unknown>;
  read: Map<string, string>;
  /** bytes the parser expected vs. what it got */
  byteLength: number;
  expectedLength: number;
}

export interface RoundTripResult {
  ok: boolean;
  mismatches: Array<{ path: string; written: string; read: string }>;
  checked: number;
}

export function parseBinary(design: Design, bytes: Uint8Array): ParseResult {
  const top = computeLayout(design);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const read = new Map<string, string>();
  const values = readFieldList(dv, bytes, 0, design.fields ?? [], design, read, '', design.name);
  return {
    values: values as Record<string, unknown>,
    read,
    byteLength: bytes.byteLength,
    expectedLength: top.size,
  };
}

export function roundTripCheck(design: Design, emitted: { bytes: Uint8Array; written: Map<string, string> }): RoundTripResult {
  const parsed = parseBinary(design, emitted.bytes);
  const mismatches: RoundTripResult['mismatches'] = [];
  for (const [path, writtenVal] of emitted.written) {
    const readVal = parsed.read.get(path);
    if (readVal === undefined) {
      mismatches.push({ path, written: writtenVal, read: '<missing>' });
    } else if (!valuesEqual(writtenVal, readVal)) {
      mismatches.push({ path, written: writtenVal, read: readVal });
    }
  }
  return { ok: mismatches.length === 0, mismatches, checked: emitted.written.size };
}

function valuesEqual(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) {
    const scale = Math.max(1, Math.abs(na), Math.abs(nb));
    return Math.abs(na - nb) <= 1e-6 * scale;
  }
  return false;
}

function canonNum(v: number | bigint, isFloat: boolean): string {
  if (typeof v === 'bigint') {
    return v.toString();
  }
  if (isFloat) {
    return Number.isInteger(v) ? v.toFixed(1) : String(v);
  }
  return String(v);
}

function decodeString(
  u8: Uint8Array,
  strType: 'char' | 'ascii' | 'utf8' | 'utf16',
  endianness: 'little' | 'big',
): string {
  if (strType === 'utf16') {
    let s = '';
    for (let i = 0; i + 1 < u8.length; i += 2) {
      const code = endianness === 'little' ? u8[i] | (u8[i + 1] << 8) : (u8[i] << 8) | u8[i + 1];
      if (code === 0) {
        break;
      }
      s += String.fromCharCode(code);
    }
    return s;
  }
  let end = u8.length;
  for (let i = 0; i < u8.length; i++) {
    if (u8[i] === 0) {
      end = i;
      break;
    }
  }
  return Buffer.from(u8.subarray(0, end)).toString('utf8');
}

function indexPath(path: string, dims: number[], flatIndex: number): string {
  if (dims.length === 0) {
    return path;
  }
  const idx: number[] = [];
  let rem = flatIndex;
  for (let d = dims.length - 1; d >= 0; d--) {
    idx[d] = rem % dims[d];
    rem = Math.floor(rem / dims[d]);
  }
  return path + idx.map((x) => `[${x}]`).join('');
}

function numeric(v: unknown): number {
  if (typeof v === 'number') {
    return v;
  }
  if (typeof v === 'bigint') {
    return Number(v);
  }
  return Number(v ?? 0) || 0;
}

function readFieldList(
  dv: DataView,
  u8: Uint8Array,
  base: number,
  fields: Design['fields'],
  design: Design,
  read: Map<string, string>,
  pathPrefix: string,
  parentName: string,
): Record<string, unknown> {
  const layout = layoutFieldList(design, fields, parentName);
  const out: Record<string, unknown> = {};
  const prior = new Map<string, number>();

  fields.forEach((field, i) => {
    const row = layout.rows[i];
    const abs = base + row.offset;
    const path = pathPrefix ? `${pathPrefix}.${field.name}` : field.name;
    const plan = planField(field, design, (n) => prior.get(n) ?? 0, parentName);
    const v = readField(dv, u8, abs, field, plan, design, read, path, parentName);
    out[field.name] = v;
    prior.set(field.name, numeric(scalarOf(v)));
  });

  return out;
}

function scalarOf(v: unknown): unknown {
  if (Array.isArray(v)) {
    return v[0];
  }
  return v;
}

function readField(
  dv: DataView,
  u8: Uint8Array,
  abs: number,
  field: Design['fields'][number],
  plan: ElementPlan,
  design: Design,
  read: Map<string, string>,
  path: string,
  parentName: string,
): unknown {
  const n = elementCount(plan.dims);

  switch (plan.kind) {
    case 'scalar': {
      const si = scalarInfo(plan.scalarType!)!;
      const isFloat = si.kind === 'float';
      const count = Math.max(n, 1);
      const arr: Array<number | bigint> = [];
      for (let i = 0; i < count; i++) {
        const off = abs + i * plan.elemSize;
        const val = readScalar(dv, off, plan.scalarType!, plan.endianness);
        read.set(indexPath(path, plan.dims, i), canonNum(val, isFloat));
        arr.push(val);
      }
      return plan.dims.length === 0 ? arr[0] : arr;
    }

    case 'bitfield': {
      const count = Math.max(n, 1);
      const results: Array<Record<string, string>> = [];
      for (let i = 0; i < count; i++) {
        const off = abs + i * plan.elemSize;
        const container = readScalar(dv, off, plan.scalarType!, plan.endianness);
        let shift = 0n;
        const obj: Record<string, string> = {};
        for (const bit of plan.bits ?? []) {
          const mask = (1n << BigInt(bit.width)) - 1n;
          const slice = (toBigInt(container) >> shift) & mask;
          read.set(`${indexPath(path, plan.dims, i)}.${bit.name}`, slice.toString());
          obj[bit.name] = slice.toString();
          shift += BigInt(bit.width);
        }
        results.push(obj);
      }
      return plan.dims.length === 0 ? results[0] : results;
    }

    case 'blob-string': {
      const count = Math.max(n, 1);
      const arr: string[] = [];
      for (let i = 0; i < count; i++) {
        const off = abs + i * plan.blobBytes!;
        const s = decodeString(u8.subarray(off, off + plan.blobBytes!), plan.strType!, plan.endianness);
        read.set(indexPath(path, plan.dims, i), s);
        arr.push(s);
      }
      return plan.dims.length === 0 ? arr[0] : arr;
    }

    case 'blob-bytes': {
      const count = Math.max(n, 1);
      const arr: string[] = [];
      for (let i = 0; i < count; i++) {
        const off = abs + i * plan.blobBytes!;
        const slice = u8.subarray(off, off + plan.blobBytes!);
        const hex = Array.from(slice, (b) => b.toString(16).padStart(2, '0')).join('');
        read.set(indexPath(path, plan.dims, i), hex);
        arr.push(hex);
      }
      return plan.dims.length === 0 ? arr[0] : arr;
    }

    case 'struct': {
      const count = Math.max(n, 1);
      const childParent = plan.structName ?? `${parentName}_${field.name}`;
      const arr: unknown[] = [];
      for (let i = 0; i < count; i++) {
        const structBase = abs + i * plan.elemSize;
        arr.push(
          readFieldList(
            dv,
            u8,
            structBase,
            plan.structFields ?? [],
            design,
            read,
            indexPath(path, plan.dims, i),
            childParent,
          ),
        );
      }
      return plan.dims.length === 0 ? arr[0] : arr;
    }

    default:
      throw new Error('readField: unhandled plan kind');
  }
}
