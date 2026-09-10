import * as vscode from 'vscode';
import * as path from 'path';
import { DESIGN_GLOB } from '../util/designFile';
import { parseDesignJson, validateDesign, computeLayout } from '../core';

class DesignNode extends vscode.TreeItem {
  constructor(public readonly resourceUri: vscode.Uri, summary: string, ok: boolean) {
    super(resourceUri, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'design';
    this.description = summary;
    this.iconPath = new vscode.ThemeIcon(ok ? 'symbol-structure' : 'warning');
    this.command = {
      command: 'vscode.openWith',
      title: 'Open Design',
      arguments: [resourceUri, 'binaryDesigner.designEditor'],
    };
    this.tooltip = vscode.workspace.asRelativePath(resourceUri);
  }
}

export class DesignsProvider implements vscode.TreeDataProvider<DesignNode> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private watcher: vscode.FileSystemWatcher | undefined;

  constructor(context: vscode.ExtensionContext) {
    this.watcher = vscode.workspace.createFileSystemWatcher(DESIGN_GLOB);
    const bump = () => this._onDidChange.fire();
    this.watcher.onDidCreate(bump, this, context.subscriptions);
    this.watcher.onDidDelete(bump, this, context.subscriptions);
    this.watcher.onDidChange(bump, this, context.subscriptions);
    context.subscriptions.push(this.watcher);
    context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument((d) => {
        if (d.uri.path.endsWith('.design.json')) {
          bump();
        }
      }),
    );
  }

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(element: DesignNode): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<DesignNode[]> {
    const uris = await vscode.workspace.findFiles(DESIGN_GLOB, '**/node_modules/**', 500);
    uris.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
    const nodes: DesignNode[] = [];
    for (const uri of uris) {
      let summary = '';
      let ok = true;
      try {
        const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        const design = parseDesignJson(text);
        const v = validateDesign(design);
        ok = v.ok;
        if (v.ok) {
          const layout = computeLayout(design);
          summary = `${design.name} · ${layout.size} B`;
        } else {
          summary = `${design.name ?? path.basename(uri.fsPath)} · ${v.errors.length} error(s)`;
        }
      } catch (e) {
        ok = false;
        summary = `parse error: ${(e as Error).message}`;
      }
      nodes.push(new DesignNode(uri, summary, ok));
    }
    return nodes;
  }
}
