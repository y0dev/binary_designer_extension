/**
 * Whole-design validation.
 *
 * `validateDesign` is pure and returns structured issues. Generators call it and
 * refuse to run when `ok` is false. The editor renders `errors`/`warnings`
 * inline against the dotted `path`.
 */

import {
  Design,
  Field,
  Issue,
  ValidationResult,
} from './types';
import {
  findDuplicates,
  validateIdentifier,
} from './identifiers';
import {
  ALL_TYPE_KEYWORDS,
  SIZED_TYPES,
  isScalar,
  parseType,
  scalarInfo,
} from './typeUtil';
import { computeLayout } from './layout';

const VALID_PACKING = [1, 2, 4, 8];

export function validateDesign(design: unknown): ValidationResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  let formRepresentable = true;

  const err = (path: string, message: string) => errors.push({ path, message, severity: 'error' });
  const warn = (path: string, message: string) => warnings.push({ path, message, severity: 'warning' });

  if (typeof design !== 'object' || design === null || Array.isArray(design)) {
    return {
      ok: false,
      errors: [{ path: '', message: 'design must be a JSON object', severity: 'error' }],
      warnings: [],
      formRepresentable: false,
    };
  }

  const d = design as Partial<Design>;

  // ---- name ----
  const nameChk = validateIdentifier(String(d.name ?? ''), 'design');
  if (!nameChk.ok) {
    err('name', nameChk.message ?? 'invalid design name');
  }

  // ---- endianness / packing ----
  if (d.endianness !== undefined && d.endianness !== 'little' && d.endianness !== 'big') {
    err('endianness', `endianness must be "little" or "big"`);
  }
  if (
    d.packing !== undefined &&
    d.packing !== false &&
    !VALID_PACKING.includes(d.packing as number)
  ) {
    err('packing', `packing must be one of ${VALID_PACKING.join(', ')}, or false to disable packing`);
  }

  // ---- constants ----
  const constantNames = new Set<string>();
  if (d.constants !== undefined) {
    if (typeof d.constants !== 'object' || d.constants === null) {
      err('constants', 'constants must be an object');
    } else {
      for (const key of Object.keys(d.constants)) {
        constantNames.add(key);
        const chk = validateIdentifier(key, 'constant');
        if (!chk.ok) {
          err(`constants.${key}`, chk.message ?? 'invalid constant name');
        } else if (chk.message) {
          warn(`constants.${key}`, chk.message);
        }
        const v = (d.constants as Record<string, unknown>)[key];
        if (typeof v !== 'number' && typeof v !== 'string') {
          err(`constants.${key}`, 'constant value must be a number or string');
        }
      }
    }
  }

  // ---- structs ----
  const structNames = new Set<string>(Object.keys(d.structs ?? {}));
  if (d.structs !== undefined) {
    if (typeof d.structs !== 'object' || d.structs === null) {
      err('structs', 'structs must be an object');
    } else {
      const tagNames: string[] = [];
      for (const key of Object.keys(d.structs)) {
        const chk = validateIdentifier(key, 'struct');
        tagNames.push(key);
        if (!chk.ok) {
          err(`structs.${key}`, chk.message ?? 'invalid struct name');
        }
        const sdef = d.structs[key];
        if (!sdef || !Array.isArray(sdef.fields)) {
          err(`structs.${key}.fields`, 'struct must have a "fields" array');
          continue;
        }
        validateFieldList(
          sdef.fields,
          `structs.${key}.fields`,
          structNames,
          constantNames,
          { err, warn },
          () => { formRepresentable = false; },
        );
      }
      for (const dup of findDuplicates(tagNames)) {
        err('structs', `duplicate struct name "${dup}"`);
      }
      // struct tags must not collide with the design name (same C tag namespace)
      if (d.name && structNames.has(String(d.name))) {
        err('structs', `struct name "${d.name}" collides with the design name`);
      }
    }
  }

  // ---- top-level fields ----
  if (!Array.isArray(d.fields)) {
    err('fields', 'design must have a "fields" array');
  } else {
    validateFieldList(
      d.fields,
      'fields',
      structNames,
      constantNames,
      { err, warn },
      () => { formRepresentable = false; },
    );
  }

  // ---- layout sanity (only if structurally sound so far) ----
  if (errors.length === 0) {
    try {
      const layout = computeLayout(d as Design);
      if (layout.size === 0 && (d.fields as Field[]).length > 0) {
        warn('fields', 'computed layout size is 0 bytes');
      }
    } catch (e) {
      err('fields', `layout engine: ${(e as Error).message}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    formRepresentable,
  };
}

interface Sink {
  err: (path: string, message: string) => void;
  warn: (path: string, message: string) => void;
}

function validateFieldList(
  fields: Field[],
  basePath: string,
  structNames: ReadonlySet<string>,
  constantNames: ReadonlySet<string>,
  sink: Sink,
  markNotFormRepresentable: () => void,
): void {
  const siblingNames: string[] = [];
  const seenSoFar = new Set<string>();

  fields.forEach((field, i) => {
    const path = `${basePath}[${i}]`;
    if (!field || typeof field !== 'object') {
      sink.err(path, 'field must be an object');
      return;
    }

    const nameChk = validateIdentifier(String(field.name ?? ''), 'field');
    if (!nameChk.ok) {
      sink.err(`${path}.name`, nameChk.message ?? 'invalid field name');
    }
    siblingNames.push(field.name);

    if (typeof field.type !== 'string' || field.type.trim() === '') {
      sink.err(`${path}.type`, 'field "type" is required');
    } else {
      validateFieldType(field, path, structNames, sink, markNotFormRepresentable);
    }

    if (field.reserved !== undefined && typeof field.reserved !== 'boolean') {
      sink.err(`${path}.reserved`, '"reserved" must be a boolean');
    }
    if (field.reserved && (field.enum || field.bits)) {
      sink.warn(`${path}.reserved`, 'a reserved field with an enum/bitfield still emits those declarations');
    }

    // ---- enum ----
    if (field.enum !== undefined) {
      if (typeof field.enum !== 'object' || field.enum === null) {
        sink.err(`${path}.enum`, 'enum must be an object of { "<int>": "LABEL" }');
      } else {
        for (const k of Object.keys(field.enum)) {
          if (!/^-?\d+$/.test(k)) {
            sink.err(`${path}.enum`, `enum key "${k}" must be an integer`);
          }
          const lblChk = validateIdentifier(field.enum[k], 'enumLabel');
          if (!lblChk.ok) {
            sink.err(`${path}.enum.${k}`, lblChk.message ?? 'invalid enum label');
          }
        }
      }
    }

    // ---- bits ----
    if (field.bits !== undefined) {
      if (!Array.isArray(field.bits)) {
        sink.err(`${path}.bits`, 'bits must be an array');
      } else {
        const si = scalarInfo(parseTypeSafe(field.type)?.base ?? '');
        const containerBits = si ? si.size * 8 : 0;
        if (!si || si.kind !== 'int') {
          sink.err(`${path}.bits`, `a bitfield needs an integer container type, got "${field.type}"`);
        }
        let sum = 0;
        const bitNames: string[] = [];
        field.bits.forEach((b, bi) => {
          const bChk = validateIdentifier(String(b?.name ?? ''), 'bitName');
          if (!bChk.ok) {
            sink.err(`${path}.bits[${bi}].name`, bChk.message ?? 'invalid bit name');
          }
          bitNames.push(b?.name);
          if (typeof b?.width !== 'number' || b.width < 1 || !Number.isInteger(b.width)) {
            sink.err(`${path}.bits[${bi}].width`, 'bit width must be a positive integer');
          } else {
            sum += b.width;
          }
        });
        for (const dup of findDuplicates(bitNames)) {
          sink.err(`${path}.bits`, `duplicate bit name "${dup}"`);
        }
        if (containerBits && sum > containerBits) {
          sink.err(`${path}.bits`, `bit widths sum to ${sum}, exceeds container size ${containerBits} bits`);
        }
        if (containerBits && sum < containerBits) {
          sink.warn(`${path}.bits`, `bit widths sum to ${sum} of ${containerBits} bits; ${containerBits - sum} unused`);
        }
      }
    }

    // ---- array ----
    if (field.array !== undefined) {
      const a = field.array;
      if (a.count === undefined && a.countField === undefined) {
        sink.err(`${path}.array`, 'array needs "count" or "countField"');
      }
      if (a.count !== undefined && (typeof a.count !== 'number' || a.count < 0 || !Number.isInteger(a.count))) {
        sink.err(`${path}.array.count`, 'array count must be a non-negative integer');
      }
      if (a.countField !== undefined) {
        const idx = fields.findIndex((f) => f.name === a.countField);
        if (idx === -1) {
          sink.err(`${path}.array.countField`, `countField "${a.countField}" is not a sibling field`);
        } else if (idx >= i) {
          sink.err(`${path}.array.countField`, `countField "${a.countField}" must appear before this field`);
        } else {
          const cf = fields[idx];
          const cfBase = parseTypeSafe(cf.type)?.base ?? '';
          if (!isScalar(cfBase) || scalarInfo(cfBase)?.kind !== 'int') {
            sink.err(`${path}.array.countField`, `countField "${a.countField}" must be an integer field`);
          }
        }
      }
    }

    // ---- value referencing a constant ----
    if (typeof field.value === 'string' && field.value.length > 0) {
      const looksLikeIdent = /^[A-Za-z_][A-Za-z0-9_]*$/.test(field.value);
      const cfBase = parseTypeSafe(field.type)?.base ?? '';
      const isTextType = cfBase === 'char' || SIZED_TYPES.has(cfBase);
      if (looksLikeIdent && !isTextType && !constantNames.has(field.value)) {
        sink.warn(`${path}.value`, `value "${field.value}" is not a declared constant; will be treated as text/0`);
      }
    }

    // multi-dimensional arrays can't be edited losslessly in the tree form
    const parsed = parseTypeSafe(field.type);
    if (parsed && parsed.dims.length > 1) {
      markNotFormRepresentable();
    }
    if (field.type === 'array' && field.items && field.items.type === 'array') {
      markNotFormRepresentable();
    }

    if (seenSoFar.has(field.name)) {
      // duplicate handled below in aggregate
    }
    seenSoFar.add(field.name);
  });

  for (const dup of findDuplicates(siblingNames)) {
    sink.err(basePath, `duplicate field name "${dup}" among siblings`);
  }
}

function validateFieldType(
  field: Field,
  path: string,
  structNames: ReadonlySet<string>,
  sink: Sink,
  markNotFormRepresentable: () => void,
): void {
  const type = field.type;

  if (type === 'struct') {
    if (!Array.isArray(field.fields)) {
      sink.err(`${path}.fields`, 'inline "struct" needs a "fields" array');
    } else {
      validateFieldList(field.fields, `${path}.fields`, structNames, new Set(), sink, markNotFormRepresentable);
    }
    return;
  }

  if (type === 'array') {
    if (!field.items) {
      sink.err(`${path}.items`, 'type "array" needs "items"');
    } else {
      validateFieldType(field.items, `${path}.items`, structNames, sink, markNotFormRepresentable);
    }
    if (!field.array) {
      sink.err(`${path}.array`, 'type "array" needs an "array" spec with count/countField');
    }
    return;
  }

  let parsed;
  try {
    parsed = parseType(type);
  } catch (e) {
    sink.err(`${path}.type`, (e as Error).message);
    return;
  }
  const base = parsed.base;

  if (isScalar(base) || SIZED_TYPES.has(base)) {
    if (SIZED_TYPES.has(base) && (typeof field.size !== 'number' || field.size < 0)) {
      sink.err(`${path}.size`, `type "${base}" needs a non-negative "size" (byte length)`);
    }
    return;
  }

  if (structNames.has(base)) {
    return;
  }

  const hint = ALL_TYPE_KEYWORDS.slice(0, 6).join(', ');
  sink.err(
    `${path}.type`,
    `unknown type "${type}" — expected a scalar (${hint}, …), a struct name (${[...structNames].join(', ') || 'none defined'}), or shorthand like "T[8]"`,
  );
}

function parseTypeSafe(type: string): ReturnType<typeof parseType> | undefined {
  try {
    return parseType(type);
  } catch {
    return undefined;
  }
}
