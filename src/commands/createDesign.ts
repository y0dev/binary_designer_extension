import * as vscode from 'vscode';
import * as path from 'path';
import { Design, validateIdentifier, sanitizeIdentifier } from '../core';

const TEMPLATE = (name: string): Design => ({
  name,
  endianness: 'little',
  packing: 1,
  description: `${name} binary layout.`,
  constants: {},
  structs: {},
  fields: [
    { name: 'magic', type: 'uint32', description: 'file magic', value: 0 },
    { name: 'version', type: 'uint16', description: 'format version', value: 1 },
  ],
});

export async function createDesignCommand(): Promise<void> {
  const rawName = await vscode.window.showInputBox({
    title: 'New Binary Design',
    prompt: 'Name for the design (a valid C identifier — it becomes the top-level struct)',
    value: 'MyFrame',
    validateInput: (v) => {
      const chk = validateIdentifier(v.trim(), 'design');
      return chk.ok ? undefined : chk.message;
    },
  });
  if (!rawName) {
    return;
  }
  const name = sanitizeIdentifier(rawName.trim());

  const folders = vscode.workspace.workspaceFolders;
  let dir: vscode.Uri;
  if (folders && folders.length === 1) {
    dir = folders[0].uri;
  } else if (folders && folders.length > 1) {
    const picked = await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Where should the design live?' });
    if (!picked) {
      return;
    }
    dir = picked.uri;
  } else {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      openLabel: 'Create design here',
    });
    if (!picked || picked.length === 0) {
      return;
    }
    dir = picked[0];
  }

  const target = vscode.Uri.joinPath(dir, `${name}.design.json`);
  try {
    await vscode.workspace.fs.stat(target);
    const overwrite = await vscode.window.showWarningMessage(
      `${path.basename(target.fsPath)} already exists. Overwrite?`,
      { modal: true },
      'Overwrite',
    );
    if (overwrite !== 'Overwrite') {
      return;
    }
  } catch {
    // does not exist — good
  }

  const body = JSON.stringify(TEMPLATE(name), null, 2) + '\n';
  await vscode.workspace.fs.writeFile(target, Buffer.from(body, 'utf8'));
  await vscode.commands.executeCommand('vscode.openWith', target, 'binaryDesigner.designEditor');
}
