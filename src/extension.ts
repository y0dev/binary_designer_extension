import * as vscode from 'vscode';
import { DesignEditorProvider } from './editor/designEditorProvider';
import { DesignsProvider } from './views/designsView';
import { createDesignCommand } from './commands/createDesign';
import {
  generateBinaryCommand,
  generateHeaderCommand,
  generateLayoutDocCommand,
  roundTripCheckCommand,
} from './commands/generators';
import { isDesignUri } from './util/designFile';

export function activate(context: vscode.ExtensionContext): void {
  const editorProvider = new DesignEditorProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      DesignEditorProvider.viewType,
      editorProvider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      },
    ),
  );

  const designs = new DesignsProvider(context);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('binaryDesigner.designs', designs),
  );

  /** For palette invocations: prefer the focused design editor. */
  const activeUri = (): vscode.Uri | undefined => {
    if (editorProvider.activeDesignUri) {
      return editorProvider.activeDesignUri;
    }
    const active = vscode.window.activeTextEditor?.document.uri;
    return active && isDesignUri(active) ? active : undefined;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('binaryDesigner.createDesign', () => createDesignCommand()),
    vscode.commands.registerCommand('binaryDesigner.refreshDesigns', () => designs.refresh()),
    vscode.commands.registerCommand('binaryDesigner.openDesign', async (uri?: vscode.Uri) => {
      const target = uri ?? activeUri();
      if (target) {
        await vscode.commands.executeCommand('vscode.openWith', target, DesignEditorProvider.viewType);
      }
    }),
    vscode.commands.registerCommand('binaryDesigner.generateBinary', (arg: unknown) =>
      generateBinaryCommand(arg, activeUri())),
    vscode.commands.registerCommand('binaryDesigner.generateHeader', (arg: unknown) =>
      generateHeaderCommand(arg, activeUri())),
    vscode.commands.registerCommand('binaryDesigner.generateLayoutDoc', (arg: unknown) =>
      generateLayoutDocCommand(arg, activeUri())),
    vscode.commands.registerCommand('binaryDesigner.roundTripCheck', (arg: unknown) =>
      roundTripCheckCommand(arg, activeUri())),
  );
}

export function deactivate(): void {
  /* nothing to clean up beyond context.subscriptions */
}
