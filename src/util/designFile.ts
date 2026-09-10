import * as vscode from 'vscode';
import * as path from 'path';
import {
  Design,
  ValidationResult,
  parseDesignJson,
  validateDesign,
} from '../core';

export const DESIGN_GLOB = '**/*.design.json';
export const DESIGN_SUFFIX = '.design.json';

export function isDesignUri(uri: vscode.Uri): boolean {
  return uri.path.toLowerCase().endsWith(DESIGN_SUFFIX);
}

export interface LoadedDesign {
  uri: vscode.Uri;
  text: string;
  design: Design;
  validation: ValidationResult;
}

/** Read + parse a design file (preferring an open editor's in-memory text). */
export async function readDesign(uri: vscode.Uri): Promise<LoadedDesign> {
  const open = vscode.workspace.textDocuments.find(
    (d) => d.uri.toString() === uri.toString(),
  );
  const text = open ? open.getText() : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  const design = parseDesignJson(text);
  const validation = validateDesign(design);
  return { uri, text, design, validation };
}

/**
 * Resolve the design a command should act on:
 *  - an explicit Uri (explorer context menu)
 *  - a Designs-view tree node ({ resourceUri })
 *  - otherwise: the tracked active design editor, or a QuickPick over the workspace
 */
export async function resolveTargetDesign(
  arg: unknown,
  activeUri: vscode.Uri | undefined,
): Promise<vscode.Uri | undefined> {
  if (arg instanceof vscode.Uri && isDesignUri(arg)) {
    return arg;
  }
  if (arg && typeof arg === 'object' && 'resourceUri' in arg) {
    const u = (arg as { resourceUri?: vscode.Uri }).resourceUri;
    if (u && isDesignUri(u)) {
      return u;
    }
  }
  if (activeUri && isDesignUri(activeUri)) {
    return activeUri;
  }

  const found = await vscode.workspace.findFiles(DESIGN_GLOB, '**/node_modules/**', 200);
  if (found.length === 0) {
    void vscode.window.showWarningMessage('No *.design.json files found in this workspace.');
    return undefined;
  }
  if (found.length === 1) {
    return found[0];
  }
  const picked = await vscode.window.showQuickPick(
    found.map((u) => ({
      label: path.basename(u.fsPath),
      description: vscode.workspace.asRelativePath(u),
      uri: u,
    })),
    { title: 'Select a design', placeHolder: 'Which design?' },
  );
  return picked?.uri;
}

/** Directory to write generated artifacts into, honoring `binaryDesigner.outputFolder`. */
export async function outputDirFor(designUri: vscode.Uri): Promise<vscode.Uri> {
  const cfg = vscode.workspace.getConfiguration('binaryDesigner');
  const folder = (cfg.get<string>('outputFolder') ?? '').trim();
  if (folder) {
    const ws = vscode.workspace.getWorkspaceFolder(designUri) ?? vscode.workspace.workspaceFolders?.[0];
    const baseUri = ws ? ws.uri : vscode.Uri.file(path.dirname(designUri.fsPath));
    const dir = vscode.Uri.joinPath(baseUri, folder);
    await vscode.workspace.fs.createDirectory(dir);
    return dir;
  }
  return vscode.Uri.file(path.dirname(designUri.fsPath));
}

/** Present validation errors as a modal and return whether generation may proceed. */
export async function assertValidForGeneration(loaded: LoadedDesign): Promise<boolean> {
  const { validation } = loaded;
  if (validation.ok) {
    return true;
  }
  const lines = validation.errors.slice(0, 8).map((e) => `• ${e.path || '(root)'}: ${e.message}`);
  const more = validation.errors.length > 8 ? `\n…and ${validation.errors.length - 8} more.` : '';
  await vscode.window.showErrorMessage(
    `Cannot generate: "${loaded.design.name ?? '(unnamed)'}" has ${validation.errors.length} validation error(s).`,
    { modal: true, detail: lines.join('\n') + more },
  );
  return false;
}
