# Changelog

## 0.4.0 — 2026-09-16

- **The size field disables itself** for types that don't use it. In the Form
  tab, `size` is only editable for `bytes` / `padding` / `ascii` / `utf8` /
  `utf16`; for a fixed-size scalar, a struct name, `struct`, or `array` it's
  grayed out, since those types have no "size" to set.
- **`"packing": false`** disables packing entirely: every member uses its
  natural (uncapped) alignment — the same layout a real C compiler produces
  with no `#pragma pack` (checked against `gcc`). Compare a design's byte
  layout with and without packing, or stay fully packed (`1`, the default) and
  add `"reserved"` fields yourself wherever you want explicit padding. The C
  header omits `#pragma pack` entirely when packing is disabled. New
  `effectiveAlign()` core export; `Packing` is now `1 | 2 | 4 | 8 | false`.
- **Undo / Redo** toolbar buttons — every edit (Form, JSON, or Binary tab) is a
  real edit on the document, so they walk VS Code's own undo stack.
- **Designs view empty state**: no folder open shows **Open Folder**; a folder
  with no `*.design.json` files shows **Create Design** and **Open a Different
  Folder** — via `contributes.viewsWelcome`, no more blank panel.

## 0.3.0 — 2026-09-15

- **Fixed: JSON edits didn't reach the Form tab.** Editing the JSON tab
  correctly re-emitted the Binary tab and layout preview (they're driven by the
  host, not the webview's local state), but the Form tree kept showing whatever
  it had before — silently stale — because the echo-detection added for the
  focus-loss fix couldn't tell a JSON-tab edit apart from the Form tab's own
  echo. The webview now tags each outbound edit with its source; only a
  genuine Form-tab echo skips the rebuild, so a JSON edit (or an external file
  change) always refreshes the Form tree.
- **New settings**: `binaryDesigner.defaultView` (which tab a design opens on),
  `binaryDesigner.generateOnSave` (auto-run chosen generators on save),
  `binaryDesigner.binaryTab.bytesPerRow` / `.maxBytesShown` (hex-dump display —
  apply live to editors already open, no reopen needed).
- **README**: a "Tabs" section explains Form / JSON / Binary as three synced
  views of one document, each with its own how-to list; Settings reorganised
  into Output / Layout / C header / Editor groups with a plain-English "how to
  change one" note.
- **Type dropdown** — a field's `type` is now a real `<select>` (common
  scalars/composites + every reusable struct currently defined), not a
  free-text box, so common types never need typing. A `[]` toggle next to it
  adds/removes a fixed-size `array` (count / countField) for any type, as an
  alternative to typing `Name[64]` shorthand. Values that aren't in the list
  (existing array shorthand, a since-renamed struct) stay selectable so no
  design is silently changed.

## 0.2.0 — 2026-09-10

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
- Renaming a reusable struct no longer wipes the Structs and Fields sections
  from the form: the rename is now idempotent (a stale/duplicate commit event
  can't write an `undefined` struct definition), it rewrites `Name[…]`
  references in every field so the design stays valid, and a malformed struct
  entry renders an inline notice instead of aborting the whole form.

## 0.1.0

Initial release.

- Form / JSON editor for `*.design.json` (tree editor, type combo, inline
  enum/bitfield tables, reusable structs, live layout preview, Save / Save draft).
- Generators: Sample Binary, C Header, Layout Doc.
- Round-trip check (emit → re-parse → assert).
- Pure, unit-tested `src/core/`: layout engine, `validateDesign`,
  `validateIdentifier`, binary emitter, C-header emitter, round-trip parser.
- `SensorFrame` example with generated `.bin` / `.h` / `_layout.md`.
