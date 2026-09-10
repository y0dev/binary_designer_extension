import * as vscode from 'vscode';
import * as path from 'path';
import {
  emitBinary,
  generateHeader,
  emitLayoutDoc,
  roundTripCheck,
  HeaderOptions,
} from '../core';
import {
  LoadedDesign,
  assertValidForGeneration,
  outputDirFor,
  readDesign,
  resolveTargetDesign,
} from '../util/designFile';

let channel: vscode.OutputChannel | undefined;
function log(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Binary File Designer');
  }
  return channel;
}

async function withDesign(
  arg: unknown,
  activeUri: vscode.Uri | undefined,
): Promise<LoadedDesign | undefined> {
  const uri = await resolveTargetDesign(arg, activeUri);
  if (!uri) {
    return undefined;
  }
  try {
    return await readDesign(uri);
  } catch (e) {
    void vscode.window.showErrorMessage(`Failed to parse ${path.basename(uri.fsPath)}: ${(e as Error).message}`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------

export async function generateBinaryCommand(arg: unknown, activeUri?: vscode.Uri): Promise<void> {
  const loaded = await withDesign(arg, activeUri);
  if (!loaded || !(await assertValidForGeneration(loaded))) {
    return;
  }

  const emit = emitBinary(loaded.design);
  const outDir = await outputDirFor(loaded.uri);
  const target = vscode.Uri.joinPath(outDir, `${loaded.design.name}.bin`);
  await vscode.workspace.fs.writeFile(target, emit.bytes);

  const defaultedNote = emit.defaulted.length
    ? ` ${emit.defaulted.length} field value(s) defaulted.`
    : '';
  const choice = await vscode.window.showInformationMessage(
    `Wrote ${path.basename(target.fsPath)} — ${emit.size} bytes.${defaultedNote}`,
    'Round-trip check',
    'Reveal',
    ...(emit.defaulted.length ? ['Show defaulted'] : []),
  );
  if (choice === 'Reveal') {
    await vscode.commands.executeCommand('revealFileInOS', target);
  } else if (choice === 'Round-trip check') {
    reportRoundTrip(loaded, emit);
  } else if (choice === 'Show defaulted') {
    log().appendLine(`\n[${new Date().toISOString()}] ${loaded.design.name}: defaulted fields`);
    for (const d of emit.defaulted) {
      log().appendLine(`  ${d}`);
    }
    log().show(true);
  }
}

export async function roundTripCheckCommand(arg: unknown, activeUri?: vscode.Uri): Promise<void> {
  const loaded = await withDesign(arg, activeUri);
  if (!loaded || !(await assertValidForGeneration(loaded))) {
    return;
  }
  reportRoundTrip(loaded, emitBinary(loaded.design));
}

function reportRoundTrip(loaded: LoadedDesign, emit: ReturnType<typeof emitBinary>): void {
  const result = roundTripCheck(loaded.design, emit);
  if (result.ok) {
    void vscode.window.showInformationMessage(
      `Round-trip OK: all ${result.checked} leaf value(s) in ${loaded.design.name} read back exactly.`,
    );
    return;
  }
  log().appendLine(`\n[${new Date().toISOString()}] ${loaded.design.name}: round-trip FAILED (${result.mismatches.length} mismatch(es))`);
  for (const m of result.mismatches) {
    log().appendLine(`  ${m.path}: wrote ${m.written}, read ${m.read}`);
  }
  log().show(true);
  void vscode.window.showErrorMessage(
    `Round-trip FAILED for ${loaded.design.name}: ${result.mismatches.length} mismatch(es). See "Binary File Designer" output.`,
  );
}

export async function generateHeaderCommand(arg: unknown, activeUri?: vscode.Uri): Promise<void> {
  const loaded = await withDesign(arg, activeUri);
  if (!loaded || !(await assertValidForGeneration(loaded))) {
    return;
  }
  const cfg = vscode.workspace.getConfiguration('binaryDesigner');

  const opts: HeaderOptions = {
    sourceFileName: path.basename(loaded.uri.fsPath),
    staticAssert: cfg.get<boolean>('header.staticAssert', true),
    includeStyle: cfg.get<'angle' | 'quote'>('header.includeStyle', 'angle'),
    enumTypedefForFields: cfg.get<boolean>('header.enumTypedefForFields', false),
    arrayMax: cfg.get<number>('header.arrayMax', 0),
  };

  // If a countField member would need a MAX and none is configured, ask.
  if (!opts.arrayMax && needsArrayMax(loaded)) {
    const answer = await vscode.window.showInputBox({
      title: 'Header array capacity',
      prompt: 'This design has a length-prefixed array that is not the last member. Enter a fixed MAX capacity for the C header.',
      value: '32',
      validateInput: (v) => (/^\d+$/.test(v) && Number(v) > 0 ? undefined : 'Enter a positive integer'),
    });
    if (answer === undefined) {
      return;
    }
    opts.arrayMax = Number(answer);
  }

  const { header, layoutDoc, warnings } = generateHeader(loaded.design, opts);
  const outDir = await outputDirFor(loaded.uri);
  const hUri = vscode.Uri.joinPath(outDir, `${loaded.design.name}.h`);
  const mdUri = vscode.Uri.joinPath(outDir, `${loaded.design.name}_layout.md`);
  await vscode.workspace.fs.writeFile(hUri, Buffer.from(header, 'utf8'));
  await vscode.workspace.fs.writeFile(mdUri, Buffer.from(layoutDoc, 'utf8'));

  for (const w of warnings) {
    log().appendLine(`header warning: ${w}`);
  }
  if (warnings.length) {
    log().show(true);
  }

  const choice = await vscode.window.showInformationMessage(
    `Wrote ${path.basename(hUri.fsPath)} and ${path.basename(mdUri.fsPath)}.`,
    'Open header',
  );
  if (choice === 'Open header') {
    await vscode.window.showTextDocument(hUri);
  }
}

export async function generateLayoutDocCommand(arg: unknown, activeUri?: vscode.Uri): Promise<void> {
  const loaded = await withDesign(arg, activeUri);
  if (!loaded || !(await assertValidForGeneration(loaded))) {
    return;
  }
  const md = emitLayoutDoc(loaded.design, { sourceFileName: path.basename(loaded.uri.fsPath) });
  const outDir = await outputDirFor(loaded.uri);
  const mdUri = vscode.Uri.joinPath(outDir, `${loaded.design.name}_layout.md`);
  await vscode.workspace.fs.writeFile(mdUri, Buffer.from(md, 'utf8'));
  const choice = await vscode.window.showInformationMessage(
    `Wrote ${path.basename(mdUri.fsPath)}.`,
    'Open',
  );
  if (choice === 'Open') {
    await vscode.commands.executeCommand('markdown.showPreview', mdUri);
  }
}

function needsArrayMax(loaded: LoadedDesign): boolean {
  const fields = loaded.design.fields ?? [];
  return fields.some(
    (f, i) => f.array?.countField !== undefined && i !== fields.length - 1,
  );
}
