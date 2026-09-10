/**
 * Sample-binary emitter.
 *
 * Walks the design, writes every field at its computed offset using its
 * design-time `value` (or a sensible default), and returns the bytes plus a
 * flat map of every leaf value that was written (used by the round-trip check).
 */

import { Design } from './types';
import { computeLayout, layoutFieldList, parseNumericValue } from './layout';
import {
  ElementPlan,
  elementCount,
  expandValues,
  isSampleExpr,
  planField,
  readScalar,
  toBigInt,
  writeScalar,
} from './codec';
import { scalarInfo } from './typeUtil';

export interface EmitResult {
  bytes: Uint8Array;
  size: number;
  /** dotted paths of fields that fell back to a default value */
  defaulted: string[];
  /** canonical string form of every leaf that was written, keyed by dotted path */
  written: Map<string, string>;
}

const UNSET = Symbol('unset');

export function emitBinary(design: Design): EmitResult {
  const top = computeLayout(design);
  const bytes = new Uint8Array(top.size);
  const dv = new DataView(bytes.buffer);
  const defaulted: string[] = [];
  const written = new Map<string, string>();

  emitFieldList(dv, bytes, 0, design.fields ?? [], design, UNSET, defaulted, written, '', design.name);

  return { bytes, size: top.size, defaulted, written };
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

function toHex(u8: Uint8Array): string {
  return Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
}

function decodeString(
  u8: Uint8Array,
  strType: 'char' | 'ascii' | 'utf8' | 'utf16',
  endianness: 'little' | 'big',
): string {
  if (strType === 'utf16') {
    let s = '';
    for (let i = 0; i + 1 < u8.length; i += 2) {
      const code = endianness === 'little'
        ? u8[i] | (u8[i + 1] << 8)
        : (u8[i] << 8) | u8[i + 1];
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

function encodeString(
  target: Uint8Array,
  value: string,
  strType: 'char' | 'ascii' | 'utf8' | 'utf16',
  endianness: 'little' | 'big',
): void {
  if (strType === 'utf16') {
    for (let i = 0; i < value.length && i * 2 + 1 < target.length; i++) {
      const code = value.charCodeAt(i);
      if (endianness === 'little') {
        target[i * 2] = code & 0xff;
        target[i * 2 + 1] = (code >> 8) & 0xff;
      } else {
        target[i * 2] = (code >> 8) & 0xff;
        target[i * 2 + 1] = code & 0xff;
      }
    }
    return;
  }
  const enc = Buffer.from(value, 'utf8');
  target.set(enc.subarray(0, target.length));
}

function pickChildValue(container: unknown, name: string, index: number, fallback: unknown): unknown {
  if (container === UNSET || container === undefined || container === null) {
    return fallback;
  }
  if (Array.isArray(container)) {
    return index < container.length ? container[index] : fallback;
  }
  if (typeof container === 'object') {
    const rec = container as Record<string, unknown>;
    return Object.prototype.hasOwnProperty.call(rec, name) ? rec[name] : fallback;
  }
  return fallback;
}

function emitFieldList(
  dv: DataView,
  u8: Uint8Array,
  base: number,
  fields: Design['fields'],
  design: Design,
  valuesContainer: unknown,
  defaulted: string[],
  written: Map<string, string>,
  pathPrefix: string,
  parentName: string,
): void {
  const layout = layoutFieldList(design, fields, parentName);
  const prior = new Map<string, number>();

  fields.forEach((field, i) => {
    const row = layout.rows[i];
    const abs = base + row.offset;
    const path = pathPrefix ? `${pathPrefix}.${field.name}` : field.name;

    const value = pickChildValue(valuesContainer, field.name, i, field.value);
    const plan = planField(field, design, (n) => prior.get(n) ?? 0, parentName);

    emitField(dv, u8, abs, field, plan, design, value, defaulted, written, path, parentName);

    prior.set(field.name, parseNumericValue(value, design.constants));
  });
}

function emitField(
  dv: DataView,
  u8: Uint8Array,
  abs: number,
  field: Design['fields'][number],
  plan: ElementPlan,
  design: Design,
  value: unknown,
  defaulted: string[],
  written: Map<string, string>,
  path: string,
  parentName: string,
): void {
  const n = elementCount(plan.dims);
  const isMissing = value === undefined || value === UNSET;
  // A reserved slot that was left empty is zero-filled on purpose — don't
  // report it as a value that "fell back to a default".
  const noteDefault = () => {
    if (!field.reserved) {
      defaulted.push(path);
    }
  };

  switch (plan.kind) {
    case 'scalar': {
      const si = scalarInfo(plan.scalarType!)!;
      const isFloat = si.kind === 'float';
      if (isMissing) {
        noteDefault();
      }
      const vals = expandValues(isMissing ? 0 : value, Math.max(n, 1), isFloat);
      for (let i = 0; i < Math.max(n, 1); i++) {
        const off = abs + i * plan.elemSize;
        const resolved = resolveConst(vals[i], design);
        writeScalar(dv, off, plan.scalarType!, resolved ?? 0, plan.endianness);
        const back = readScalar(dv, off, plan.scalarType!, plan.endianness);
        written.set(indexPath(path, plan.dims, i), canonNum(back, isFloat));
      }
      return;
    }

    case 'bitfield': {
      if (isMissing) {
        noteDefault();
      }
      const container = plan.scalarType!;
      const count = Math.max(n, 1);
      for (let i = 0; i < count; i++) {
        const off = abs + i * plan.elemSize;
        const obj = Array.isArray(value) ? value[i] : value;
        let acc = 0n;
        let shift = 0n;
        for (const bit of plan.bits ?? []) {
          const raw = resolveBitValue(
            obj && typeof obj === 'object'
              ? (obj as Record<string, unknown>)[bit.name]
              : undefined,
            bit,
          );
          const mask = (1n << BigInt(bit.width)) - 1n;
          acc |= (toBigInt(raw) & mask) << shift;
          shift += BigInt(bit.width);
        }
        writeScalar(dv, off, container, acc, plan.endianness);
        const back = readScalar(dv, off, container, plan.endianness) as number | bigint;
        let s = 0n;
        for (const bit of plan.bits ?? []) {
          const mask = (1n << BigInt(bit.width)) - 1n;
          const slice = (toBigInt(back) >> s) & mask;
          written.set(`${indexPath(path, plan.dims, i)}.${bit.name}`, slice.toString());
          s += BigInt(bit.width);
        }
      }
      return;
    }

    case 'blob-string': {
      const count = Math.max(n, 1);
      if (isMissing) {
        noteDefault();
      }
      for (let i = 0; i < count; i++) {
        const off = abs + i * plan.blobBytes!;
        const slice = u8.subarray(off, off + plan.blobBytes!);
        slice.fill(0);
        const raw = n === 0 ? value : Array.isArray(value) ? value[i] : value;
        const str = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
        encodeString(slice, str, plan.strType!, plan.endianness);
        written.set(
          indexPath(path, plan.dims, i),
          decodeString(slice, plan.strType!, plan.endianness),
        );
      }
      return;
    }

    case 'blob-bytes': {
      const count = Math.max(n, 1);
      if (isMissing) {
        noteDefault();
      }
      for (let i = 0; i < count; i++) {
        const off = abs + i * plan.blobBytes!;
        const slice = u8.subarray(off, off + plan.blobBytes!);
        slice.fill(0);
        const raw = n === 0 ? value : Array.isArray(value) ? value[i] : value;
        fillBytes(slice, raw);
        written.set(indexPath(path, plan.dims, i), toHex(slice));
      }
      return;
    }

    case 'struct': {
      const count = Math.max(n, 1);
      const childParent = plan.structName ?? `${parentName}_${field.name}`;
      const exprValues = isSampleExpr(value) ? expandValues(value, count, false) : undefined;
      if (isMissing && n > 0) {
        noteDefault();
      }
      for (let i = 0; i < count; i++) {
        const structBase = abs + i * plan.elemSize;
        const elemValue = exprValues
          ? exprValues[i]
          : n === 0
            ? value
            : Array.isArray(value)
              ? value[i]
              : value;
        emitFieldList(
          dv,
          u8,
          structBase,
          plan.structFields ?? [],
          design,
          elemValue,
          defaulted,
          written,
          indexPath(path, plan.dims, i),
          childParent,
        );
      }
      return;
    }

    default:
      throw new Error(`emitField: unhandled plan kind`);
  }
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

function resolveConst(v: unknown, design: Design): unknown {
  if (typeof v === 'string' && design.constants && Object.prototype.hasOwnProperty.call(design.constants, v)) {
    return parseNumericValue(design.constants[v]);
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^[+-]?0x[0-9a-f]+$/i.test(s)) {
      return parseInt(s, 16);
    }
  }
  return v;
}

function resolveBitValue(raw: unknown, bit: { enum?: Record<string, string> }): number | bigint {
  if (raw === undefined || raw === null) {
    return 0;
  }
  if (typeof raw === 'number' || typeof raw === 'bigint') {
    return raw;
  }
  if (typeof raw === 'string') {
    if (bit.enum) {
      for (const [k, label] of Object.entries(bit.enum)) {
        if (label === raw) {
          return Number(k);
        }
      }
    }
    return toBigInt(raw);
  }
  if (typeof raw === 'boolean') {
    return raw ? 1 : 0;
  }
  return 0;
}

function fillBytes(target: Uint8Array, raw: unknown): void {
  if (raw == null) {
    return;
  }
  if (typeof raw === 'number') {
    target.fill(raw & 0xff);
    return;
  }
  if (typeof raw === 'string') {
    const hex = raw.replace(/^0x/i, '').replace(/[^0-9a-f]/gi, '');
    for (let i = 0; i < target.length && i * 2 + 1 < hex.length + 1; i++) {
      const byte = parseInt(hex.substr(i * 2, 2), 16);
      if (!Number.isNaN(byte)) {
        target[i] = byte;
      }
    }
    return;
  }
  if (Array.isArray(raw)) {
    for (let i = 0; i < target.length && i < raw.length; i++) {
      target[i] = Number(raw[i]) & 0xff;
    }
  }
}
