// @ts-check
/* Binary File Designer — webview editor (vanilla, no framework). */
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();

  const SCALARS = [
    'uint8', 'int8', 'uint16', 'int16', 'uint32', 'int32', 'uint64', 'int64',
    'float32', 'float64', 'float', 'double',
    'char', 'bytes', 'padding', 'ascii', 'utf8', 'utf16', 'struct', 'array',
  ];
  const SIZED = new Set(['bytes', 'padding', 'ascii', 'utf8', 'utf16']);

  const state = {
    model: /** @type {any} */ (null),
    text: '',
    lastApplied: '',
    view: 'form',
    jsonFocused: false,
    autoJsonNotified: false,
    layout: /** @type {any} */ (null),
    structs: /** @type {any[]} */ ([]),
    errors: /** @type {{path:string,message:string}[]} */ ([]),
    warnings: /** @type {{path:string,message:string}[]} */ ([]),
    parseError: /** @type {string|null} */ (null),
    formRepresentable: true,
    bytes: /** @type {Uint8Array|null} */ (null),
    byteSize: /** @type {number|null} */ (null),
    defaulted: /** @type {string[]} */ ([]),
    hoverField: /** @type {string|null} */ (null),
    /** drag state for the Binary tab (top-level field reorder) */
    hexDrag: /** @type {number|null} */ (null),
    /** drag state for the Binary tab (new-field insertion): a template field */
    hexInsert: /** @type {any} */ (null),
    /** drag state for the Form tree (sibling reorder): the live array + index */
    formDrag: /** @type {{list:any[], index:number}|null} */ (null),
    /** binaryDesigner.binaryTab.maxBytesShown / bytesPerRow — see the 'config' message */
    hexRenderCap: 8192,
    hexBytesPerRow: 16,
  };

  // Settings baked into the page when it was opened (defaultView, binaryTab.*);
  // binaryTab.* also updates live via a 'config' message if the setting changes
  // while the editor is open.
  (function readInitialConfig() {
    const ds = (document.body && document.body.dataset) || {};
    const bpr = Number(ds.bytesPerRow);
    const cap = Number(ds.maxBytesShown);
    if (bpr === 8 || bpr === 16 || bpr === 32) state.hexBytesPerRow = bpr;
    if (Number.isFinite(cap) && cap >= 256) state.hexRenderCap = cap;
  })();

  const FIELD_HUES = [210, 145, 32, 275, 0, 190, 95, 320, 55, 250, 165, 15];
  function hashStr(s) {
    let h = 0;
    const str = String(s);
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return h;
  }
  /** Colour keyed by field NAME so a field keeps its colour when reordered. */
  function fieldHue(name) {
    const i = ((hashStr(name) % FIELD_HUES.length) + FIELD_HUES.length) % FIELD_HUES.length;
    return FIELD_HUES[i];
  }
  function fieldColor(name) { return `hsl(${fieldHue(name)} 68% 60%)`; }
  function fieldColorSoft(name) { return `hsl(${fieldHue(name)} 68% 55% / 0.24)`; }

  // ---- tiny DOM helpers ----------------------------------------------------
  /**
   * @param {string} tag
   * @param {Record<string, any>=} props
   * @param {any=} kids
   * @returns {any}
   */
  function el(tag, props, kids) {
    const n = document.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k === 'html') n.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of [].concat(kids || [])) {
      if (c == null || c === false) continue;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return n;
  }
  /** @param {string} id @returns {any} */
  const $ = (id) => document.getElementById(id);

  // ---- messaging -----------------------------------------------------
  //
  // Three views, one document: the Form tab mutates `state.model` directly and
  // serializes it; the JSON tab sends its raw text untouched; the Binary tab is
  // pure output (bytes + layout the host computed) and never edits anything.
  // Every `update` the host sends is authoritative for the OTHER tabs — so a
  // JSON edit must refresh the Form tree, and (already true) both edits refresh
  // the Binary tab and layout preview, since those are rebuilt from the message
  // unconditionally below.
  //
  // The one case that must NOT rebuild the Form DOM is the echo of an edit the
  // Form tab itself just made: `state.model` there was already mutated in
  // place, so there's nothing new to apply, and rebuilding would steal focus
  // mid-keystroke. `pendingSource` tracks who sent the in-flight `apply` so the
  // echo can be told apart from a JSON-tab edit, an external file change, or
  // the initial load — all of which DO need the form rebuilt.
  /** @type {'form'|'json'|null} */
  let pendingSource = null;

  function apply() {
    let text;
    try {
      text = JSON.stringify(state.model, null, 2) + '\n';
    } catch (e) {
      return;
    }
    state.lastApplied = text;
    pendingSource = 'form';
    vscode.postMessage({ type: 'apply', text });
  }

  /** Send raw text typed in the JSON tab — `state.model` is refreshed from the host's echo. */
  function applyJsonText(text) {
    state.lastApplied = text;
    pendingSource = 'json';
    vscode.postMessage({ type: 'apply', text });
  }

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg) return;
    if (msg.type === 'config') {
      // binaryDesigner.binaryTab.* changed — apply live, no reopen needed.
      if (msg.bytesPerRow === 8 || msg.bytesPerRow === 16 || msg.bytesPerRow === 32) {
        state.hexBytesPerRow = msg.bytesPerRow;
      }
      if (typeof msg.maxBytesShown === 'number' && msg.maxBytesShown >= 256) {
        state.hexRenderCap = msg.maxBytesShown;
      }
      renderHex();
      return;
    }
    if (msg.type !== 'update') return;
    state.text = msg.text;
    state.errors = msg.errors || [];
    state.warnings = msg.warnings || [];
    state.parseError = msg.parseError || null;
    state.formRepresentable = msg.formRepresentable !== false;
    state.layout = msg.layout || null;
    state.structs = msg.structs || [];
    state.byteSize = typeof msg.byteSize === 'number' ? msg.byteSize : null;
    state.defaulted = msg.defaulted || [];
    state.bytes = msg.bytesB64 ? b64ToBytes(msg.bytesB64) : null;

    // Exact text compare isn't enough on its own: VS Code may normalise EOLs
    // (CRLF on Windows) or final-newline settings, which would make our own
    // change look external. Fall back to a semantic (parsed-model) comparison
    // before concluding this is a genuine echo.
    const norm = (s) => String(s == null ? '' : s).replace(/\r\n/g, '\n');
    const source = pendingSource;
    pendingSource = null;
    const looksLikeEcho = norm(msg.text) === norm(state.lastApplied) || (() => {
      try { return JSON.stringify(JSON.parse(msg.text)) === JSON.stringify(state.model); } catch (e) { return false; }
    })();
    const isFormEcho = source === 'form' && looksLikeEcho;

    if (!isFormEcho) {
      try {
        state.model = JSON.parse(msg.text);
      } catch (e) {
        // leave model as-is; JSON tab shows the raw text and parse error
      }
    }
    if (!state.jsonFocused) $('json-text').value = msg.text;

    if (!state.formRepresentable && !state.autoJsonNotified) {
      state.autoJsonNotified = true;
      setView('json');
    }
    // Rebuild the form for anything that isn't our own form echo — in
    // particular, a JSON-tab edit always rebuilds it (nothing there can lose
    // focus: the JSON textarea is what's focused, not a form input).
    if (!isFormEcho) renderForm();
    renderStatus();
    renderPreview();
    renderHex();
  });

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ---- view toggle -----------------------------------------------------
  function setView(v) {
    state.view = v;
    $('view-form').classList.toggle('hidden', v !== 'form');
    $('view-json').classList.toggle('hidden', v !== 'json');
    $('view-binary').classList.toggle('hidden', v !== 'binary');
    $('tab-form').classList.toggle('active', v === 'form');
    $('tab-json').classList.toggle('active', v === 'json');
    $('tab-binary').classList.toggle('active', v === 'binary');
    if (v === 'binary') renderHex();
  }
  $('tab-form').addEventListener('click', () => setView('form'));
  $('tab-json').addEventListener('click', () => setView('json'));
  $('tab-binary').addEventListener('click', () => setView('binary'));

  // binaryDesigner.defaultView — which tab a design opens on (all three always
  // show the same document; the JSON tab still auto-opens instead when the
  // design isn't form-representable, once data arrives).
  (function applyDefaultView() {
    const dv = document.body && document.body.dataset && document.body.dataset.defaultView;
    if (dv === 'json' || dv === 'binary') setView(dv);
  })();

  $('json-text').addEventListener('focus', () => { state.jsonFocused = true; });
  $('json-text').addEventListener('blur', () => { state.jsonFocused = false; });
  let jsonTimer = 0;
  $('json-text').addEventListener('input', () => {
    clearTimeout(jsonTimer);
    jsonTimer = setTimeout(() => applyJsonText($('json-text').value), 250);
  });

  $('btn-save').addEventListener('click', () => vscode.postMessage({ type: 'save' }));
  $('btn-save-draft').addEventListener('click', () => vscode.postMessage({ type: 'saveDraft' }));
  const cmd = (c) => vscode.postMessage({ type: 'command', command: c });
  // Undo/redo the underlying document (VS Code's own undo stack — every edit
  // gets there via a real WorkspaceEdit). Ctrl/Cmd+Z may already reach it
  // depending on what has focus inside the webview; these buttons work
  // regardless of focus.
  $('btn-undo').addEventListener('click', () => cmd('undo'));
  $('btn-redo').addEventListener('click', () => cmd('redo'));
  $('btn-bin').addEventListener('click', () => cmd('binaryDesigner.generateBinary'));
  $('btn-hdr').addEventListener('click', () => cmd('binaryDesigner.generateHeader'));
  $('btn-doc').addEventListener('click', () => cmd('binaryDesigner.generateLayoutDoc'));
  $('btn-rt').addEventListener('click', () => cmd('binaryDesigner.roundTripCheck'));

  // ---- status --------------------------------------------------------
  function renderStatus() {
    const root = $('status');
    root.textContent = '';
    if (state.parseError) {
      root.appendChild(el('div', { class: 'msg error', text: 'JSON parse error: ' + state.parseError }));
      return;
    }
    if (!state.formRepresentable) {
      root.appendChild(el('div', {
        class: 'msg info',
        text: 'This design uses features the tree form can’t fully represent (e.g. multi-dimensional arrays). Edit it in the JSON tab.',
      }));
    }
    for (const e of state.errors.slice(0, 12)) {
      root.appendChild(el('div', { class: 'msg error', text: `✗ ${e.path || '(root)'}: ${e.message}` }));
    }
    for (const w of state.warnings.slice(0, 8)) {
      root.appendChild(el('div', { class: 'msg warn', text: `⚠ ${w.path || '(root)'}: ${w.message}` }));
    }
    if (!state.errors.length && !state.warnings.length && !state.parseError && state.formRepresentable) {
      root.appendChild(el('div', { class: 'msg info', text: '✓ Design is valid.' }));
    }
  }

  // ---- layout preview --------------------------------------------------
  function renderPreview() {
    const body = $('preview-body');
    body.textContent = '';
    const l = state.layout;
    if (!l) {
      body.appendChild(el('p', { class: 'hint', text: state.parseError ? 'Fix the JSON to see the layout.' : 'Layout unavailable.' }));
      return;
    }

    // ---- struct sizes ----
    const structs = state.structs || [];
    if (structs.length > 0) {
      const srows = structs.map((s) => el('tr', {}, [
        el('td', {}, [el('code', { text: s.name }), s.reusable ? null : el('span', { class: 'dim', text: ' inline' })]),
        el('td', { class: 'num', text: String(s.size) }),
        el('td', { class: 'num', text: String(s.align) }),
      ]));
      srows.push(el('tr', { class: 'frame-row' }, [
        el('td', {}, [el('code', { text: l.name || 'frame' }), el('span', { class: 'dim', text: ' frame' })]),
        el('td', { class: 'num', text: String(l.size) }),
        el('td', { class: 'num', text: String(l.align) }),
      ]));
      body.appendChild(el('h4', { text: 'Struct sizes' }));
      body.appendChild(el('table', { class: 'structs' }, [
        el('thead', {}, el('tr', {}, [
          el('th', { text: 'Struct' }), el('th', { class: 'num', text: 'Size' }), el('th', { class: 'num', text: 'Align' }),
        ])),
        el('tbody', {}, srows),
      ]));
    }

    // ---- frame layout ----
    const rows = [];
    let cursor = 0;
    for (const r of l.rows) {
      if (r.offset > cursor) {
        rows.push(el('tr', { class: 'pad' }, [
          el('td', { class: 'num', text: String(cursor) }),
          el('td', { text: '(padding)' }),
          el('td', { text: `uint8_t[${r.offset - cursor}]` }),
          el('td', { class: 'num', text: String(r.offset - cursor) }),
        ]));
      }
      const each = r.elemCount > 1 ? ` (${r.elemSize}×${r.elemCount})` : '';
      const tr = el('tr', {
        'data-field': r.name,
        class: r.reserved ? 'reserved' : '',
        style: `--fc-soft:${fieldColorSoft(r.name)}`,
        onmouseenter: () => setHoverField(r.name),
        onmouseleave: () => setHoverField(null),
      }, [
        el('td', { class: 'num', text: String(r.offset) }),
        el('td', {}, el('code', { text: r.name })),
        el('td', {}, el('code', { text: r.cType + r.cArraySuffix })),
        el('td', { class: 'num', title: each ? `${r.elemSize} bytes each × ${r.elemCount}` : '' }, [
          String(r.size),
          each ? el('span', { class: 'dim', text: each }) : null,
        ]),
      ]);
      rows.push(tr);
      cursor = r.offset + r.size;
    }
    if (l.size > cursor) {
      rows.push(el('tr', { class: 'pad' }, [
        el('td', { class: 'num', text: String(cursor) }),
        el('td', { text: '(tail padding)' }),
        el('td', { text: `uint8_t[${l.size - cursor}]` }),
        el('td', { class: 'num', text: String(l.size - cursor) }),
      ]));
    }
    body.appendChild(el('h4', { text: 'Frame layout' }));
    body.appendChild(el('table', {}, [
      el('thead', {}, el('tr', {}, [
        el('th', { text: 'Off' }), el('th', { text: 'Name' }), el('th', { text: 'C type' }), el('th', { class: 'num', text: 'Size' }),
      ])),
      el('tbody', {}, rows),
    ]));
    body.appendChild(el('div', { class: 'totals' }, [
      el('div', { text: `Frame: ${l.size} bytes` }),
      el('div', { text: `Alignment: ${l.align} · packing ${l.packing} · ${l.endianness}-endian` }),
      el('div', { text: `Padding inserted: ${l.paddingBytes} bytes` }),
    ]));
  }

  // ---- Binary tab: hex dump + drag-to-reorder -----------------------
  function topFields() {
    const l = state.layout;
    if (!l || !Array.isArray(l.rows)) return [];
    return l.rows.map((r, i) => ({
      name: r.name,
      index: i,
      offset: r.offset,
      size: r.size,
      cType: r.cType + r.cArraySuffix,
      reserved: !!r.reserved,
      color: fieldColor(r.name),
      colorSoft: fieldColorSoft(r.name),
    }));
  }
  function fieldIndexAt(off, fields) {
    for (const f of fields) {
      if (off >= f.offset && off < f.offset + f.size) return f.index;
    }
    return -1;
  }
  function safeSel(name) {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name || '') ? name : null;
  }
  function clearDropMarks() {
    document.querySelectorAll('.drop-before, .drop-after').forEach((n) => {
      n.classList.remove('drop-before', 'drop-after');
    });
  }
  function setHoverField(name) {
    state.hoverField = name || null;
    document
      .querySelectorAll('.hex-cell.active, .ascii-cell.active, .chip.active, #preview tr.active')
      .forEach((n) => n.classList.remove('active'));
    const sel = safeSel(name);
    if (!sel) return;
    document
      .querySelectorAll(
        `.hex-cell[data-field="${sel}"], .ascii-cell[data-field="${sel}"], .chip[data-name="${sel}"], #preview tr[data-field="${sel}"]`,
      )
      .forEach((n) => n.classList.add('active'));
  }

  function reorderTopField(from, to) {
    state.hexDrag = null;
    clearDropMarks();
    if (!state.model || !Array.isArray(state.model.fields)) return;
    if (from === to || from + 1 === to) return;
    mutate((d) => {
      const arr = d.fields;
      const item = arr.splice(from, 1)[0];
      arr.splice(from < to ? to - 1 : to, 0, item);
    }, true);
  }

  // ---- add new fields from the Binary tab ----
  const SCALAR_TEMPLATES = {
    u8: 'uint8', u16: 'uint16', u32: 'uint32', u64: 'uint64',
    i8: 'int8', i16: 'int16', i32: 'int32', i64: 'int64',
    f32: 'float32', f64: 'float64',
  };
  function newFieldTemplate(kind) {
    if (SCALAR_TEMPLATES[kind]) return { type: SCALAR_TEMPLATES[kind], value: 0 };
    if (kind === 'char') return { type: 'char[16]', value: '' };
    if (kind === 'bytes') return { type: 'bytes', size: 4, value: 0 };
    if (kind === 'enum') return { type: 'uint8', value: 0, enum: { '0': 'ZERO' } };
    if (kind === 'array') return { type: 'uint16', value: 0, array: { count: 4 } };
    if (kind === 'struct') return { type: 'struct', fields: [{ name: 'field1', type: 'uint32' }] };
    if (kind === 'rsv') return { type: 'uint32', reserved: true };
    if (kind === 'rsv-arr') return { type: 'bytes', size: 16, reserved: true };
    return { type: kind }; // a reusable struct name
  }
  function templateBase(t) {
    if (t.reserved) return 'reserved';
    if (t.type === 'struct') return 'group';
    if (t.enum) return 'kind';
    if (t.array) return 'items';
    if (/^char/.test(String(t.type))) return 'text';
    if (t.type === 'bytes') return 'blob';
    if (structNames().indexOf(t.type) >= 0) return String(t.type).toLowerCase();
    return String(t.type).replace(/[^a-z0-9]/gi, '') || 'field';
  }
  function insertTopField(template, atIndex) {
    state.hexInsert = null;
    clearDropMarks();
    if (!state.model || typeof state.model !== 'object') return;
    mutate((d) => {
      d.fields = Array.isArray(d.fields) ? d.fields : [];
      const named = { name: nextName(d.fields, templateBase(template)) };
      for (const k of Object.keys(template)) named[k] = template[k];
      const i = Math.max(0, Math.min(atIndex, d.fields.length));
      d.fields.splice(i, 0, named);
    }, true);
  }

  function paletteBtn(label, kind, extraClass) {
    const b = el('span', { class: 'add-chip' + (extraClass ? ' ' + extraClass : ''), draggable: 'true', title: `Add ${label} field — click to append, drag onto a byte to insert`, text: label });
    b.addEventListener('click', () => insertTopField(newFieldTemplate(kind), Number.MAX_SAFE_INTEGER));
    b.addEventListener('dragstart', (e) => {
      state.hexInsert = newFieldTemplate(kind);
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'copy';
        try { e.dataTransfer.setData('text/plain', 'add:' + kind); } catch (_e) { /* ignore */ }
      }
      b.classList.add('dragging');
    });
    b.addEventListener('dragend', () => {
      state.hexInsert = null;
      b.classList.remove('dragging');
      clearDropMarks();
    });
    return b;
  }
  function renderAddPalette() {
    const wrap = $('hex-add');
    if (!wrap) return;
    wrap.textContent = '';
    if (!state.model || typeof state.model !== 'object') return;
    wrap.appendChild(el('span', { class: 'add-label', text: 'Add:' }));
    for (const k of ['u8', 'u16', 'u32', 'u64', 'i8', 'i16', 'i32', 'i64', 'f32', 'f64']) {
      wrap.appendChild(paletteBtn(k, k));
    }
    wrap.appendChild(paletteBtn('char[16]', 'char'));
    wrap.appendChild(paletteBtn('bytes[4]', 'bytes'));
    wrap.appendChild(paletteBtn('enum', 'enum'));
    wrap.appendChild(paletteBtn('array', 'array'));
    wrap.appendChild(paletteBtn('struct', 'struct'));
    wrap.appendChild(paletteBtn('reserve u32', 'rsv', 'rsv'));
    wrap.appendChild(paletteBtn('reserve[16]', 'rsv-arr', 'rsv'));
    for (const s of structNames()) {
      wrap.appendChild(paletteBtn(s, s));
    }
  }

  function attachHexDrag(node, idx) {
    node.addEventListener('dragstart', (e) => {
      state.hexDrag = idx;
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', String(idx)); } catch (_e) { /* ignore */ }
      }
      node.classList.add('dragging');
      document.querySelectorAll(`.hex-cell[data-idx="${idx}"]`).forEach((c) => c.classList.add('dragging-src'));
    });
    node.addEventListener('dragend', () => {
      state.hexDrag = null;
      node.classList.remove('dragging');
      clearDropMarks();
      document.querySelectorAll('.dragging-src').forEach((c) => c.classList.remove('dragging-src'));
    });
  }
  function attachHexDrop(node, targetIdx) {
    node.addEventListener('dragover', (e) => {
      const inserting = state.hexInsert != null;
      const moving = state.hexDrag != null && state.hexDrag !== targetIdx;
      if (!inserting && !moving) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = inserting ? 'copy' : 'move';
      const r = node.getBoundingClientRect();
      const after = e.clientX - r.left > r.width / 2;
      clearDropMarks();
      node.classList.add(after ? 'drop-after' : 'drop-before');
      node._after = after;
    });
    node.addEventListener('dragleave', () => node.classList.remove('drop-before', 'drop-after'));
    node.addEventListener('drop', (e) => {
      if (state.hexInsert == null && state.hexDrag == null) return;
      e.preventDefault();
      const after = !!node._after;
      const at = targetIdx + (after ? 1 : 0);
      if (state.hexInsert != null) insertTopField(state.hexInsert, at);
      else reorderTopField(state.hexDrag, at);
    });
  }

  function renderHex() {
    const fieldsWrap = $('hex-fields');
    const body = $('hex-body');
    const help = $('hex-help');
    if (!fieldsWrap || !body) return;
    fieldsWrap.textContent = '';
    body.textContent = '';
    renderAddPalette();

    const l = state.layout;
    if (!l) {
      help.hidden = true;
      body.appendChild(el('p', {
        class: 'hint',
        text: state.parseError
          ? 'Fix the JSON to preview the binary.'
          : 'Resolve the validation errors above to preview the binary.',
      }));
      return;
    }

    const fields = topFields();
    for (const f of fields) {
      const chip = el('span', {
        class: 'chip' + (f.reserved ? ' reserved' : ''),
        draggable: 'true',
        'data-idx': String(f.index),
        'data-name': f.name,
        title: `${f.name}: ${f.cType} @ ${f.offset}, ${f.size} B${f.reserved ? ' — reserved' : ''} — drag onto another field to reorder`,
        style: `--fc:${f.color}; --fc-soft:${f.colorSoft}`,
        onmouseenter: () => setHoverField(f.name),
        onmouseleave: () => setHoverField(null),
      }, [
        el('span', { class: 'swatch' }),
        el('span', { text: f.name }),
        f.reserved ? el('span', { class: 'rsv-tag', text: 'rsv' }) : null,
        el('span', { class: 'meta', text: `@${f.offset}·${f.size}B` }),
      ]);
      attachHexDrag(chip, f.index);
      attachHexDrop(chip, f.index);
      fieldsWrap.appendChild(chip);
    }

    if (!state.bytes) {
      let msg;
      if (state.byteSize === 0) {
        msg = 'No fields yet — use “Add” above to place the first field.';
        help.hidden = false;
      } else if (state.byteSize != null) {
        msg = `Sample binary is ${state.byteSize.toLocaleString()} bytes — too large to render inline. Use “⬇ .bin” to write the file.`;
        help.hidden = true;
      } else {
        msg = 'Sample binary unavailable (design must be valid).';
        help.hidden = true;
      }
      body.appendChild(el('p', { class: 'hint', text: msg }));
      return;
    }
    help.hidden = false;

    const bytes = state.bytes;
    const total = bytes.length;
    const shown = Math.min(total, state.hexRenderCap);
    const perRow = state.hexBytesPerRow;
    const half = Math.floor(perRow / 2);

    for (let base = 0; base < shown; base += perRow) {
      const row = el('div', { class: 'hex-row' });
      row.appendChild(el('span', { class: 'hex-off', text: base.toString(16).padStart(8, '0') }));
      const hexCols = el('span', { class: 'hex-hexcols' });
      const asc = el('span', { class: 'hex-ascii' });
      for (let j = 0; j < perRow; j++) {
        const off = base + j;
        const mid = j === half ? ' ' : '';
        if (off >= shown) {
          hexCols.appendChild(el('span', { class: 'hex-cell gap', text: mid + '   ' }));
          continue;
        }
        const b = bytes[off];
        const fi = fieldIndexAt(off, fields);
        const cellProps = { class: 'hex-cell', text: mid + b.toString(16).padStart(2, '0') + ' ', 'data-off': String(off) };
        const ascProps = { class: 'ascii-cell', text: mid + (b >= 32 && b < 127 ? String.fromCharCode(b) : '.') };
        if (fi >= 0) {
          const f = fields[fi];
          cellProps.class += ' f' + (off === f.offset ? ' f-start' : '') + (off === f.offset + f.size - 1 ? ' f-end' : '') + (f.reserved ? ' rsv' : '');
          cellProps['data-field'] = f.name;
          cellProps['data-idx'] = String(fi);
          cellProps.style = `--fc:${f.color}; --fc-soft:${f.colorSoft}`;
          cellProps.draggable = 'true';
          ascProps.class += ' f' + (f.reserved ? ' rsv' : '');
          ascProps['data-field'] = f.name;
          ascProps.style = cellProps.style;
        } else {
          cellProps.class += ' gap';
        }
        const cell = el('span', cellProps);
        if (fi >= 0) {
          cell.addEventListener('mouseenter', () => setHoverField(fields[fi].name));
          cell.addEventListener('mouseleave', () => setHoverField(null));
          attachHexDrag(cell, fi);
          attachHexDrop(cell, fi);
        }
        hexCols.appendChild(cell);
        asc.appendChild(el('span', ascProps));
      }
      row.appendChild(hexCols);
      row.appendChild(asc);
      body.appendChild(row);
    }

    if (total > shown) {
      body.appendChild(el('div', {
        class: 'hint',
        text: `… ${(total - shown).toLocaleString()} more bytes not shown (total ${total.toLocaleString()} B).`,
      }));
    }

    const endzone = el('div', { class: 'hex-endzone', text: 'drop here → add / move field to the end' });
    endzone.addEventListener('dragover', (e) => {
      if (state.hexDrag == null && state.hexInsert == null) return;
      e.preventDefault();
      endzone.classList.add('drop');
    });
    endzone.addEventListener('dragleave', () => endzone.classList.remove('drop'));
    endzone.addEventListener('drop', (e) => {
      if (state.hexDrag == null && state.hexInsert == null) return;
      e.preventDefault();
      endzone.classList.remove('drop');
      if (state.hexInsert != null) insertTopField(state.hexInsert, fields.length);
      else reorderTopField(state.hexDrag, fields.length);
    });
    body.appendChild(endzone);

    if (state.defaulted && state.defaulted.length) {
      body.appendChild(el('div', {
        class: 'hint',
        text: `${state.defaulted.length} field value(s) fell back to a default (0 / NUL / zero-fill).`,
      }));
    }

    if (state.hoverField) setHoverField(state.hoverField);
  }

  // ---- form ----------------------------------------------------------
  function mutate(fn, restructure) {
    if (!state.model) return;
    fn(state.model);
    if (restructure) renderForm();
    apply();
  }

  function parseValueInput(raw) {
    const s = raw.trim();
    if (s === '') return undefined;
    if (/^-?\d+$/.test(s)) return parseInt(s, 10);
    if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
    return s; // constant name, hex string, or text
  }
  function valueToInput(v) {
    if (v === undefined || v === null) return '';
    if (typeof v === 'object') return '';
    return String(v);
  }

  function structNames() {
    return state.model && state.model.structs ? Object.keys(state.model.structs) : [];
  }

  /** Every type name the dropdown offers: scalars/composites, then live struct names. */
  function typeOptions() {
    return SCALARS.concat(structNames());
  }

  /**
   * A real `<select>` for a field's `type` — common scalar/composite types plus
   * every reusable struct currently defined, so nothing needs to be typed. If
   * the field's current type isn't one of those (e.g. array shorthand like
   * `Vec3[64]`, or a struct that no longer exists), it's kept as its own
   * selected option at the top so the value is never silently discarded — pick
   * a different option to replace it, or use the array toggle (`[]`) for a
   * fixed-size array of the selected type instead of typing `[n]`.
   */
  function typeSelectInput(current, onChange) {
    const known = typeOptions();
    const values = known.includes(current) ? known : [current, ...known];
    const n = el('select', { class: 'type-select' });
    for (const t of values) {
      const o = el('option', { value: t, text: t });
      if (t === current) o.selected = true;
      n.appendChild(o);
    }
    n.addEventListener('change', () => onChange(n.value));
    return n;
  }

  function renderForm() {
    const root = $('form-root');
    root.textContent = '';
    if (!state.model || typeof state.model !== 'object') {
      root.appendChild(el('p', { class: 'hint', text: 'Open the JSON tab — the design could not be parsed as an object.' }));
      return;
    }
    try {
      renderFormBody(root, state.model);
    } catch (e) {
      root.appendChild(el('div', {
        class: 'msg error',
        text: 'The form could not be rendered (' + (e && e.message ? e.message : e) + '). Edit the design in the JSON tab.',
      }));
    }
  }

  function renderFormBody(root, m) {
    // ---- meta ----
    const meta = el('fieldset', {}, el('legend', { text: 'Design' }));
    const grid = el('div', { class: 'meta-grid' });
    grid.appendChild(el('label', { text: 'name' }));
    grid.appendChild(textInput(m.name || '', (v) => mutate((d) => { d.name = v; }), { cls: isBadId(m.name) ? 'invalid' : '' }));
    grid.appendChild(el('label', { text: 'endianness' }));
    grid.appendChild(selectInput(['little', 'big'], m.endianness || 'little', (v) => mutate((d) => { d.endianness = v; })));
    grid.appendChild(el('label', { text: 'packing' }));
    grid.appendChild(selectInput(['1', '2', '4', '8'], String(m.packing || 1), (v) => mutate((d) => { d.packing = parseInt(v, 10); })));
    grid.appendChild(el('label', { text: 'description' }));
    grid.appendChild(textInput(m.description || '', (v) => mutate((d) => { d.description = v || undefined; })));
    meta.appendChild(grid);
    root.appendChild(meta);

    // ---- constants ----
    const cfs = el('fieldset', {}, el('legend', { text: 'Constants' }));
    const consts = m.constants || {};
    for (const key of Object.keys(consts)) {
      cfs.appendChild(el('div', { class: 'kv-row' }, [
        textInput(key, (v) => mutate((d) => {
          d.constants = d.constants || {};
          if (!v || v === key || d.constants[key] === undefined || d.constants[v] !== undefined) return;
          d.constants[v] = d.constants[key];
          delete d.constants[key];
        }, true), { placeholder: 'NAME', commit: true }),
        textInput(valueToInput(consts[key]), (v) => mutate((d) => { d.constants[key] = parseValueInput(v); }), { placeholder: '0 or 0x…' }),
        iconBtn('✕', 'remove', () => mutate((d) => { delete d.constants[key]; }, true)),
      ]));
    }
    cfs.appendChild(el('button', {
      text: '+ constant',
      onclick: () => mutate((d) => {
        d.constants = d.constants || {};
        let k = 'NEW_CONST'; let i = 1;
        while (d.constants[k] !== undefined) k = 'NEW_CONST_' + (++i);
        d.constants[k] = 0;
      }, true),
    }));
    root.appendChild(cfs);

    // ---- reusable structs ----
    const sfs = el('fieldset', {}, el('legend', { text: 'Reusable structs' }));
    const structs = m.structs || {};
    for (const key of Object.keys(structs)) {
      const box = el('div', { class: 'field' });
      box.appendChild(el('div', { class: 'toolbar-sub' }, [
        el('span', { text: 'struct ' }),
        textInput(key, (v) => mutate((d) => renameStruct(d, key, v), true),
          { cls: isBadId(key) ? 'invalid' : '', commit: true }),
        iconBtn('✕', 'delete struct', () => mutate((d) => { if (d.structs) delete d.structs[key]; }, true)),
      ]));
      const sd = structs[key];
      if (!sd || typeof sd !== 'object') {
        box.appendChild(el('div', { class: 'hint', text: 'malformed struct — fix it in the JSON tab' }));
        sfs.appendChild(box);
        continue;
      }
      sd.fields = Array.isArray(sd.fields) ? sd.fields : [];
      const children = el('div', { class: 'children' });
      renderFieldList(children, sd.fields);
      children.appendChild(addFieldBar(sd.fields));
      box.appendChild(children);
      sfs.appendChild(box);
    }
    sfs.appendChild(el('button', {
      text: '+ struct',
      onclick: () => mutate((d) => {
        d.structs = d.structs || {};
        let i = 1; while (d.structs['Struct' + i]) i++;
        d.structs['Struct' + i] = { fields: [{ name: 'field1', type: 'uint32' }] };
      }, true),
    }));
    root.appendChild(sfs);

    // ---- top-level fields ----
    const ffs = el('fieldset', {}, el('legend', { text: 'Fields (top-level struct body)' }));
    m.fields = Array.isArray(m.fields) ? m.fields : [];
    const list = el('div');
    renderFieldList(list, m.fields);
    ffs.appendChild(list);
    ffs.appendChild(addFieldBar(m.fields));
    root.appendChild(ffs);
  }

  function addFieldBar(list) {
    return el('div', { class: 'toolbar-sub' }, [
      el('button', { text: '+ Field', onclick: () => mutate(() => list.push({ name: nextName(list, 'field'), type: 'uint32' }), true) }),
      el('button', { text: '+ Array', onclick: () => mutate(() => list.push({ name: nextName(list, 'items'), type: 'uint16', array: { count: 4 } }), true) }),
      el('button', { text: '+ Enum', onclick: () => mutate(() => list.push({ name: nextName(list, 'kind'), type: 'uint8', enum: { '0': 'ZERO' } }), true) }),
      el('button', { text: '+ Struct', onclick: () => mutate(() => list.push({ name: nextName(list, 'group'), type: 'struct', fields: [] }), true) }),
    ]);
  }

  function nextName(list, base) {
    const used = new Set(list.map((f) => f.name));
    if (!used.has(base)) return base;
    let i = 2; while (used.has(base + '_' + i)) i++;
    return base + '_' + i;
  }

  /** Rewrite every `type` that is `<oldName>` or `<oldName>[…]` to use `newName`. */
  function renameTypeRefs(fields, oldName, newName) {
    if (!Array.isArray(fields)) return;
    for (const f of fields) {
      if (f && typeof f.type === 'string') {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)((?:\[\s*\d+\s*\])*)$/.exec(f.type);
        if (m && m[1] === oldName) f.type = newName + m[2];
      }
      if (f && Array.isArray(f.fields)) renameTypeRefs(f.fields, oldName, newName);
      if (f && f.items && typeof f.items === 'object') renameTypeRefs([f.items], oldName, newName);
    }
  }

  /**
   * Rename a reusable struct key, keeping references in sync. No-ops (rather than
   * corrupting the model) if the source is already gone or the target name is
   * taken — a stale/duplicate commit event must not clobber the definition.
   */
  function renameStruct(d, oldName, newName) {
    d.structs = d.structs || {};
    if (!newName || newName === oldName) return;
    if (d.structs[oldName] === undefined) return;
    if (d.structs[newName] !== undefined) return;
    d.structs[newName] = d.structs[oldName];
    delete d.structs[oldName];
    renameTypeRefs(d.fields || [], oldName, newName);
    for (const k of Object.keys(d.structs)) {
      renameTypeRefs((d.structs[k] && d.structs[k].fields) || [], oldName, newName);
    }
  }

  function renderFieldList(container, list) {
    list.forEach((field, index) => container.appendChild(renderField(field, list, index)));
  }

  /** Drag-to-reorder a `.field` row within its own sibling list. */
  function attachFormDrag(box, grip, list, index) {
    grip.setAttribute('draggable', 'true');
    grip.addEventListener('dragstart', (e) => {
      state.formDrag = { list, index };
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', 'field'); } catch (_e) { /* ignore */ }
      }
      box.classList.add('dragging');
    });
    grip.addEventListener('dragend', () => {
      state.formDrag = null;
      box.classList.remove('dragging');
      clearDropMarks();
    });
    box.addEventListener('dragover', (e) => {
      const d = state.formDrag;
      if (!d || d.list !== list || d.index === index) return;
      e.preventDefault();
      e.stopPropagation();
      const r = box.getBoundingClientRect();
      const after = e.clientY - r.top > r.height / 2;
      clearDropMarks();
      box.classList.add(after ? 'drop-after' : 'drop-before');
      box._after = after;
    });
    box.addEventListener('dragleave', () => box.classList.remove('drop-before', 'drop-after'));
    box.addEventListener('drop', (e) => {
      const d = state.formDrag;
      if (!d || d.list !== list) return;
      e.preventDefault();
      e.stopPropagation();
      const after = !!box._after;
      box.classList.remove('drop-before', 'drop-after');
      const from = d.index;
      const to = index + (after ? 1 : 0);
      state.formDrag = null;
      if (from === to || from + 1 === to) return;
      mutate(() => {
        const item = list.splice(from, 1)[0];
        list.splice(from < to ? to - 1 : to, 0, item);
      }, true);
    });
  }

  function renderField(field, list, index) {
    const box = el('div', { class: 'field' + (field.reserved ? ' reserved' : '') });
    const baseType = String(field.type || '').replace(/\[.*$/, '');
    const isStruct = field.type === 'struct';
    const isArrayType = field.type === 'array';

    const main = el('div', { class: 'field-main' });
    main.appendChild(textInput(field.name || '', (v) => mutate(() => { field.name = v; }), {
      cls: 'name' + (isBadId(field.name) ? ' invalid' : ''), placeholder: 'name',
    }));

    const typeInput = typeSelectInput(field.type || 'uint32', (v) => mutate(() => { field.type = v; }, true));
    main.appendChild(typeInput);

    const needsSize = SIZED.has(baseType);
    main.appendChild(textInput(
      field.size != null ? String(field.size) : '',
      (v) => mutate(() => { field.size = v === '' ? undefined : parseInt(v, 10); }),
      {
        placeholder: needsSize ? 'size*' : 'size (n/a)',
        type: 'number',
        disabled: !needsSize,
        title: needsSize
          ? 'byte length — required for bytes/padding/ascii/utf8/utf16'
          : `"${baseType}" has a fixed size; size doesn't apply`,
      },
    ));

    main.appendChild(selectInput(['', 'little', 'big'], field.endianness || '', (v) => mutate(() => { field.endianness = v || undefined; }), ['(endian)', 'little', 'big']));

    const valDisabled = field.bits || (field.value && typeof field.value === 'object');
    main.appendChild(textInput(
      valDisabled ? '(edit in JSON)' : valueToInput(field.value),
      (v) => mutate(() => { field.value = parseValueInput(v); }),
      { placeholder: 'value', disabled: valDisabled ? true : undefined },
    ));

    const acts = el('div', { class: 'row-actions' });
    const grip = el('span', { class: 'field-grip', title: 'drag to reorder', text: '⠿' });
    acts.appendChild(grip);
    const rsvBtn = iconBtn('rsv', field.reserved ? 'reserved (click to clear)' : 'mark reserved for future use', () => mutate(() => {
      field.reserved ? delete field.reserved : (field.reserved = true);
    }, true));
    if (field.reserved) rsvBtn.classList.add('on');
    acts.appendChild(rsvBtn);
    acts.appendChild(iconBtn('{}', 'toggle enum', () => mutate(() => {
      field.enum ? delete field.enum : (field.enum = { '0': 'ZERO' });
    }, true)));
    acts.appendChild(iconBtn('b', 'toggle bitfield', () => mutate(() => {
      field.bits ? delete field.bits : (field.bits = [{ name: 'bit0', width: 1 }]);
    }, true)));
    if (!isArrayType) {
      const arrBtn = iconBtn('[]', field.array ? 'fixed array (click to clear)' : 'make this a fixed-size array', () => mutate(() => {
        field.array ? delete field.array : (field.array = { count: 4 });
      }, true));
      if (field.array) arrBtn.classList.add('on');
      acts.appendChild(arrBtn);
    }
    if (isStruct || isArrayType) {
      acts.appendChild(iconBtn('›', 'add child', () => mutate(() => {
        if (isStruct) { field.fields = field.fields || []; field.fields.push({ name: nextName(field.fields, 'field'), type: 'uint32' }); }
        else { field.items = field.items || { name: 'item', type: 'uint16' }; }
      }, true)));
    }
    acts.appendChild(iconBtn('↑', 'move up', () => index > 0 && mutate(() => { [list[index - 1], list[index]] = [list[index], list[index - 1]]; }, true)));
    acts.appendChild(iconBtn('↓', 'move down', () => index < list.length - 1 && mutate(() => { [list[index + 1], list[index]] = [list[index], list[index + 1]]; }, true)));
    acts.appendChild(iconBtn('⧉', 'duplicate', () => mutate(() => { list.splice(index + 1, 0, JSON.parse(JSON.stringify(field))); }, true)));
    acts.appendChild(iconBtn('✕', 'delete', () => mutate(() => { list.splice(index, 1); }, true)));
    main.appendChild(acts);
    box.appendChild(main);

    box.appendChild(el('div', { class: 'field-desc' }, textInput(field.description || '', (v) => mutate(() => { field.description = v || undefined; }), { placeholder: 'description' })));

    // array spec
    if (field.array || isArrayType) {
      field.array = field.array || {};
      const a = field.array;
      const bar = el('div', { class: 'toolbar-sub' });
      bar.appendChild(el('span', { class: 'hint', text: 'array:' }));
      bar.appendChild(el('label', { text: 'count' }));
      bar.appendChild(textInput(a.count != null ? String(a.count) : '', (v) => mutate(() => {
        a.count = v === '' ? undefined : parseInt(v, 10);
        if (a.count != null) delete a.countField;
      }, true), { type: 'number', commit: true }));
      bar.appendChild(el('label', { text: 'countField' }));
      bar.appendChild(textInput(a.countField || '', (v) => mutate(() => {
        a.countField = v || undefined;
        if (a.countField) delete a.count;
      }, true), { commit: true }));
      bar.appendChild(iconBtn('✕', 'remove array', () => mutate(() => { delete field.array; }, true)));
      box.appendChild(bar);
    }

    // enum subtable
    if (field.enum) {
      const t = el('div', { class: 'subtable' }, el('div', { class: 'hint', text: 'enum (value → label)' }));
      for (const k of Object.keys(field.enum)) {
        t.appendChild(el('div', { class: 'enum-row' }, [
          textInput(k, (v) => mutate(() => {
            if (!field.enum || !v || v === k || field.enum[k] === undefined || field.enum[v] !== undefined) return;
            field.enum[v] = field.enum[k]; delete field.enum[k];
          }, true), { type: 'number', placeholder: 'int', commit: true }),
          textInput(field.enum[k], (v) => mutate(() => { field.enum[k] = v; }), { placeholder: 'LABEL', cls: isBadId(field.enum[k]) ? 'invalid' : '' }),
          iconBtn('✕', 'remove', () => mutate(() => { delete field.enum[k]; }, true)),
        ]));
      }
      t.appendChild(el('button', {
        text: '+ row', onclick: () => mutate(() => {
          let n = 0; while (field.enum[String(n)] !== undefined) n++;
          field.enum[String(n)] = 'LABEL' + n;
        }, true),
      }));
      box.appendChild(t);
    }

    // bits subtable
    if (field.bits) {
      const t = el('div', { class: 'subtable' }, el('div', { class: 'hint', text: 'bitfield (name : width), LSB first' }));
      field.bits.forEach((b, bi) => {
        t.appendChild(el('div', { class: 'bit-row' }, [
          textInput(b.name || '', (v) => mutate(() => { b.name = v; }), { placeholder: 'name', cls: isBadId(b.name) ? 'invalid' : '' }),
          textInput(b.width != null ? String(b.width) : '', (v) => mutate(() => { b.width = parseInt(v, 10) || 1; }), { type: 'number', placeholder: 'width' }),
          iconBtn('↑', 'up', () => bi > 0 && mutate(() => { [field.bits[bi - 1], field.bits[bi]] = [field.bits[bi], field.bits[bi - 1]]; }, true)),
          iconBtn('↓', 'down', () => bi < field.bits.length - 1 && mutate(() => { [field.bits[bi + 1], field.bits[bi]] = [field.bits[bi], field.bits[bi + 1]]; }, true)),
          iconBtn('✕', 'remove', () => mutate(() => { field.bits.splice(bi, 1); }, true)),
        ]));
      });
      t.appendChild(el('button', {
        text: '+ bit', onclick: () => mutate(() => { field.bits.push({ name: 'bit' + field.bits.length, width: 1 }); }, true),
      }));
      box.appendChild(t);
    }

    // nested struct fields
    if (isStruct && Array.isArray(field.fields)) {
      const children = el('div', { class: 'children' });
      renderFieldList(children, field.fields);
      children.appendChild(addFieldBar(field.fields));
      box.appendChild(children);
    }

    // nested array items
    if (isArrayType && field.items) {
      const children = el('div', { class: 'children' }, el('div', { class: 'hint', text: 'items:' }));
      renderFieldList(children, [field.items]);
      box.appendChild(children);
    }

    attachFormDrag(box, grip, list, index);
    return box;
  }

  // ---- input factories ----
  //
  // Two modes:
  //  - default: fire `onChange` on a debounced `input` (live) AND on `change`.
  //    The caller MUST NOT rebuild the form from this handler, or focus is lost.
  //  - opts.commit: fire `onChange` ONLY when the edit is committed (blur / Enter
  //    / picking a datalist option). Use this for anything that renames an
  //    object key or otherwise needs the caller to rebuild the tree — the
  //    rebuild then happens after focus has already left the input.
  function textInput(value, onChange, opts) {
    opts = opts || {};
    const n = el('input', {
      type: opts.type || 'text',
      value: value,
      placeholder: opts.placeholder || '',
      class: opts.cls || '',
      list: opts.list || undefined,
      disabled: opts.disabled,
      title: opts.title || undefined,
    });
    if (opts.commit) {
      n.addEventListener('change', () => {
        if (n.value !== value) onChange(n.value);
      });
      n.addEventListener('keydown', (e) => { if (e.key === 'Enter') n.blur(); });
      return n;
    }
    let t = 0;
    n.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => onChange(n.value), 200);
    });
    n.addEventListener('change', () => { clearTimeout(t); onChange(n.value); });
    return n;
  }
  function selectInput(values, current, onChange, labels) {
    const n = el('select', {});
    values.forEach((v, i) => {
      const o = el('option', { value: v, text: labels ? labels[i] : (v === '' ? '(default)' : v) });
      if (v === current) o.selected = true;
      n.appendChild(o);
    });
    n.addEventListener('change', () => onChange(n.value));
    return n;
  }
  function iconBtn(glyph, title, onclick) {
    return el('button', { class: 'icon', title: title, text: glyph, onclick });
  }
  function isBadId(name) {
    return !name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name));
  }

  vscode.postMessage({ type: 'ready' });
})();
