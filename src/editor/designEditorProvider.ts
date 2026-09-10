import * as vscode from 'vscode';
import {
  computeLayout,
  emitBinary,
  parseDesignJson,
  validateDesign,
} from '../core';

/** Above this the "Binary" tab shows a summary instead of a full hex dump. */
const MAX_HEX_BYTES = 512 * 1024;

interface WebviewToHost {
  type: 'ready' | 'apply' | 'save' | 'saveDraft' | 'command';
  /** full replacement document text (apply) */
  text?: string;
  /** command id for 'command' */
  command?: string;
}

interface HostToWebview {
  type: 'update';
  text: string;
  parseError: string | null;
  errors: Array<{ path: string; message: string }>;
  warnings: Array<{ path: string; message: string }>;
  formRepresentable: boolean;
  layout: ReturnType<typeof computeLayout> | null;
  /** base64 of the emitted sample binary (null when invalid or too large) */
  bytesB64: string | null;
  /** total emitted size in bytes, even when `bytesB64` is omitted for size */
  byteSize: number | null;
  /** dotted paths of fields that fell back to a default value */
  defaulted: string[];
}

export class DesignEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'binaryDesigner.designEditor';

  /** URI of the most recently focused design editor, for palette commands. */
  public activeDesignUri: vscode.Uri | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
  ): void {
    const webview = webviewPanel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    webview.html = this.getHtml(webview);

    this.activeDesignUri = document.uri;

    const post = () => {
      const text = document.getText();
      const payload: HostToWebview = {
        type: 'update',
        text,
        parseError: null,
        errors: [],
        warnings: [],
        formRepresentable: true,
        layout: null,
        bytesB64: null,
        byteSize: null,
        defaulted: [],
      };
      try {
        const design = parseDesignJson(text);
        const v = validateDesign(design);
        payload.errors = v.errors.map((e) => ({ path: e.path, message: e.message }));
        payload.warnings = v.warnings.map((e) => ({ path: e.path, message: e.message }));
        payload.formRepresentable = v.formRepresentable;
        if (v.ok || v.errors.every((e) => e.path.startsWith('fields') === false)) {
          try {
            payload.layout = computeLayout(design);
          } catch {
            payload.layout = null;
          }
        }
        if (v.ok && payload.layout) {
          try {
            const emit = emitBinary(design);
            payload.byteSize = emit.size;
            payload.defaulted = emit.defaulted;
            if (emit.size <= MAX_HEX_BYTES) {
              payload.bytesB64 = Buffer.from(emit.bytes).toString('base64');
            }
          } catch {
            /* emit failed — Binary tab shows the reason from validation */
          }
        }
      } catch (e) {
        payload.parseError = (e as Error).message;
      }
      void webview.postMessage(payload);
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString()) {
        post();
      }
    });

    const focusSub = webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.active) {
        this.activeDesignUri = document.uri;
      }
    });

    const msgSub = webview.onDidReceiveMessage(async (msg: WebviewToHost) => {
      switch (msg.type) {
        case 'ready':
          post();
          break;
        case 'apply':
          if (typeof msg.text === 'string' && msg.text !== document.getText()) {
            await this.replaceAll(document, msg.text);
          }
          break;
        case 'save':
          await this.saveWithGate(document, false);
          break;
        case 'saveDraft':
          await this.saveWithGate(document, true);
          break;
        case 'command':
          if (msg.command) {
            this.activeDesignUri = document.uri;
            await vscode.commands.executeCommand(msg.command, document.uri);
          }
          break;
      }
    });

    webviewPanel.onDidDispose(() => {
      changeSub.dispose();
      focusSub.dispose();
      msgSub.dispose();
    });
  }

  private async replaceAll(document: vscode.TextDocument, text: string): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(0, 0, document.lineCount, 0),
      text,
    );
    await vscode.workspace.applyEdit(edit);
  }

  private async saveWithGate(document: vscode.TextDocument, draft: boolean): Promise<void> {
    if (!draft) {
      try {
        const v = validateDesign(parseDesignJson(document.getText()));
        if (!v.ok) {
          const go = await vscode.window.showWarningMessage(
            `This design has ${v.errors.length} validation error(s). Save anyway?`,
            { modal: true },
            'Save anyway',
          );
          if (go !== 'Save anyway') {
            return;
          }
        }
      } catch (e) {
        const go = await vscode.window.showWarningMessage(
          `This design is not valid JSON (${(e as Error).message}). Save anyway?`,
          { modal: true },
          'Save anyway',
        );
        if (go !== 'Save anyway') {
          return;
        }
      }
    }
    await document.save();
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'editor.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'editor.css'),
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource}`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Binary File Designer</title>
</head>
<body>
  <header class="toolbar">
    <div class="tabs">
      <button id="tab-form" class="tab active" data-view="form">Form</button>
      <button id="tab-json" class="tab" data-view="json">JSON</button>
      <button id="tab-binary" class="tab" data-view="binary">Binary</button>
    </div>
    <div class="spacer"></div>
    <button id="btn-save" class="primary" title="Save (blocked on errors)">Save</button>
    <button id="btn-save-draft" title="Save even when invalid">Save draft</button>
    <span class="sep"></span>
    <button id="btn-bin" title="Generate Sample Binary file">⬇ .bin</button>
    <button id="btn-hdr" title="Generate C Header">⬇ .h</button>
    <button id="btn-doc" title="Generate Layout Doc">⬇ layout</button>
    <button id="btn-rt" title="Round-trip Check">↺ Round-trip</button>
  </header>

  <div id="status" class="status"></div>

  <main>
    <section id="view-form" class="view">
      <div id="form-root"></div>
    </section>
    <section id="view-json" class="view hidden">
      <textarea id="json-text" spellcheck="false"></textarea>
    </section>
    <section id="view-binary" class="view hidden">
      <div id="hex-add" class="hex-add"></div>
      <div id="hex-fields" class="hex-fields"></div>
      <p class="hint" id="hex-help">
        Click a type in <b>Add</b> to append a field, or drag it onto a byte to insert it there.
        Drag an existing field — its chip or its bytes — onto another to reorder the top-level struct.
      </p>
      <div id="hex-body" class="hex-body"></div>
    </section>
    <aside id="preview">
      <h3>Layout preview</h3>
      <div id="preview-body"></div>
    </aside>
  </main>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}
