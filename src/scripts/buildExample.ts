/**
 * Regenerates examples/generated/* from examples/SensorFrame.design.json and
 * asserts the round-trip check passes. Run with `npm run example`.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  emitBinary,
  generateHeader,
  parseDesignJson,
  roundTripCheck,
  validateDesign,
} from '../core';

function main(): void {
  const root = path.resolve(__dirname, '..', '..', '..');
  const srcPath = path.join(root, 'examples', 'SensorFrame.design.json');
  const outDir = path.join(root, 'examples', 'generated');
  fs.mkdirSync(outDir, { recursive: true });

  const text = fs.readFileSync(srcPath, 'utf8');
  const design = parseDesignJson(text);

  const v = validateDesign(design);
  if (!v.ok) {
    console.error('design is invalid:');
    for (const e of v.errors) {
      console.error(`  ${e.path}: ${e.message}`);
    }
    process.exit(1);
  }
  for (const w of v.warnings) {
    console.warn(`  warning ${w.path}: ${w.message}`);
  }

  const emit = emitBinary(design);
  fs.writeFileSync(path.join(outDir, `${design.name}.bin`), emit.bytes);
  console.log(`${design.name}.bin: ${emit.size} bytes`);
  if (emit.defaulted.length) {
    const shown = emit.defaulted.slice(0, 8).join(', ');
    const more = emit.defaulted.length > 8 ? `, … (+${emit.defaulted.length - 8})` : '';
    console.log(`  defaulted (${emit.defaulted.length}): ${shown}${more}`);
  }

  const rt = roundTripCheck(design, emit);
  if (!rt.ok) {
    console.error(`round-trip FAILED (${rt.mismatches.length} mismatches):`);
    for (const m of rt.mismatches.slice(0, 20)) {
      console.error(`  ${m.path}: wrote ${m.written}, read ${m.read}`);
    }
    process.exit(1);
  }
  console.log(`  round-trip OK (${rt.checked} leaves verified)`);

  const hdr = generateHeader(design, {
    sourceFileName: `${design.name}.design.json`,
    staticAssert: true,
    includeStyle: 'angle',
  });
  fs.writeFileSync(path.join(outDir, `${design.name}.h`), hdr.header);
  fs.writeFileSync(path.join(outDir, `${design.name}_layout.md`), hdr.layoutDoc);
  for (const w of hdr.warnings) {
    console.warn(`  header warning: ${w}`);
  }
  console.log(`${design.name}.h + ${design.name}_layout.md written to ${path.relative(root, outDir)}`);
}

main();
