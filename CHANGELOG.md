# Changelog

## Unreleased

- **Struct sizes** — the layout preview and `<name>_layout.md` now show every
  reusable and inline struct with its own size / alignment / field count, not
  just the whole frame; the frame table gains an `elem × count` column and
  per-row element sizes. New `structSummaries(design)` core export; `LayoutRow`
  carries `elemSize` / `elemCount` / `structTag`.
- **README** — a "Creating a frame" image walkthrough (create → header →
  reusable struct → Binary tab → generate).
- **Binary tab** in the design editor: a live, colour-coded hex dump of the
  sample binary, with hover cross-highlighting against the layout preview.
- **Add fields from the Binary tab**: an Add palette (`u8`…`f64`, `char[16]`,
  `bytes[4]`, `enum`, `array`, `struct`, reusable structs) — click to append or
  drag onto a byte to insert at that position.
- **Reserved fields** (`"reserved": true`, the `reserve u32` / `reserve[16]`
  palette entries, or the `rsv` toggle on a Form row): a future-use slot that
  keeps its size/offset, is zero-filled unless given a `value`, is excluded from
  the "defaulted" report, rendered hatched, and annotated *reserved* in the
  generated C header and layout doc.
- **Drag-to-reorder** the top-level struct: drag a field's chip or its
  highlighted bytes in the Binary tab, or a row's grip in the Form tree.

### Fixed

- Form fields (constant name, struct name, field type, array `count` /
  `countField`, enum key) no longer lose focus after a keystroke: renames and
  type edits now commit on blur / Enter, and the "is this our own edit?" check
  tolerates VS Code's CRLF / final-newline normalization instead of forcing a
  full form rebuild.

## 0.1.0

Initial release.

- Form / JSON editor for `*.design.json` (tree editor, type combo, inline
  enum/bitfield tables, reusable structs, live layout preview, Save / Save draft).
- Generators: Sample Binary, C Header, Layout Doc.
- Round-trip check (emit → re-parse → assert).
- Pure, unit-tested `src/core/`: layout engine, `validateDesign`,
  `validateIdentifier`, binary emitter, C-header emitter, round-trip parser.
- `SensorFrame` example with generated `.bin` / `.h` / `_layout.md`.
