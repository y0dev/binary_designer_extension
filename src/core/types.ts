/**
 * Core data model for a Binary File Designer *Design*.
 *
 * A Design is pure JSON. Nothing in it is ever executed. The "expression"
 * vocabulary used for sample values (see {@link SampleExpr}) is a fixed, tiny
 * enum evaluated by hand-written code in `emitBinary.ts`.
 */

export type Endianness = 'little' | 'big';
export type Packing = 1 | 2 | 4 | 8;

export interface Design {
  /** Required. Must be a valid C identifier. */
  name: string;
  /** "little" | "big". Default "little". */
  endianness?: Endianness;
  /** Struct alignment/packing in bytes: 1 | 2 | 4 | 8. Default 1. */
  packing?: Packing;
  description?: string;
  /** Named constants usable as field values (`"value": "MAGIC"`). */
  constants?: Record<string, string | number>;
  /** Reusable nested structs, keyed by C identifier. */
  structs?: Record<string, StructDef>;
  /** The top-level struct body. */
  fields: Field[];
}

export interface StructDef {
  description?: string;
  fields: Field[];
}

export interface ArraySpec {
  /** Fixed array length. */
  count?: number;
  /** Length-prefixed array: count = design-time value of an earlier sibling field. */
  countField?: string;
  /** Element definition for a nested `array` + `items`. */
  items?: Field;
}

/** integer value (as a string key) -> C enum label */
export type EnumSpec = Record<string, string>;

export interface BitSpec {
  /** Bit-slice name. Must be a valid C identifier. */
  name: string;
  /** Width in bits. */
  width: number;
  description?: string;
  enum?: EnumSpec;
}

/**
 * A sample-value expression. Deliberately tiny and non-Turing-complete.
 *  - `["const", v]`        -> every element = v
 *  - `["ramp", start, step?]` -> start, start+step, start+2*step, ...
 *  - `["repeat", ...vals]` -> vals cycled to fill the array
 *  - `["random", seed]`    -> deterministic PRNG stream (mulberry32)
 */
export type SampleExpr =
  | ['const', number | string]
  | ['ramp', number, number?]
  | ['repeat', ...Array<number | string>]
  | ['random', number];

export interface Field {
  /** Required. Unique among siblings. Valid C identifier. */
  name: string;
  /**
   * One of:
   *  - a scalar: uint8 int8 uint16 int16 uint32 int32 uint64 int64 float32 float64
   *  - float / double (aliases), bytes, padding, char, ascii, utf8, utf16
   *  - a struct name from `design.structs`
   *  - `"struct"` with an inline `fields` array
   *  - `"array"` with `array` + `items`
   *  - shorthand: `"float32[8]"`, `"Vec3[64]"`, `"int16[4][3]"`, `"char[16]"`
   */
  type: string;
  description?: string;
  /** Design-time default used when generating the sample binary. */
  value?: unknown;
  /** Optional explicit offset. Usually omitted; packing/order decide. */
  offset?: number;
  /** Optional per-field endianness override. */
  endianness?: Endianness;
  /** Byte length for `bytes`, `padding`, `ascii`, `utf8`, `utf16`. */
  size?: number;
  /** Fixed or length-prefixed array wrapper. */
  array?: ArraySpec;
  /** Element definition when `type === "array"`. */
  items?: Field;
  /** Field list when `type === "struct"` (inline). */
  fields?: Field[];
  /** integer -> C enum. The field keeps its integer type. */
  enum?: EnumSpec;
  /** Bitfield: this integer container is split into named bit-slices. */
  bits?: BitSpec[];
  /**
   * Marks this field as a reserved slot held for future use. It occupies its
   * normal size at its normal offset, is zero-filled by the emitter unless an
   * explicit `value` is given, and is *not* reported as a "defaulted" field.
   * The C header and layout doc annotate it as reserved.
   */
  reserved?: boolean;
}

export interface Issue {
  /** Dotted path to the offending node, e.g. `fields[2].bits[1].width`. */
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ValidationResult {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  /** False when the tree editor can't losslessly represent the design (e.g. multi-dim arrays). */
  formRepresentable: boolean;
}

export type IdentifierKind =
  | 'design'
  | 'struct'
  | 'field'
  | 'enumLabel'
  | 'bitName'
  | 'constant';

export interface IdentifierCheck {
  ok: boolean;
  /** Human-readable reason when `ok` is false; a hint otherwise. */
  message?: string;
  /** A normalized, valid replacement the UI can apply with one click. */
  suggestion?: string;
}

export interface LayoutRow {
  name: string;
  /** Fully qualified C member type, e.g. `Vec3`, `uint16_t`, `char`. */
  cType: string;
  /** Array dimensions appended in C order, e.g. `[64]` or `[4][3]`. */
  cArraySuffix: string;
  offset: number;
  size: number;
  align: number;
  note?: string;
  /** True when the source field is a reserved-for-future-use slot. */
  reserved?: boolean;
}

export interface LayoutResult {
  rows: LayoutRow[];
  /** Total size including tail padding. */
  size: number;
  /** Alignment of the whole struct. */
  align: number;
  /** Total padding bytes the packer inserted (between members + tail). */
  paddingBytes: number;
  packing: Packing;
  endianness: Endianness;
}
