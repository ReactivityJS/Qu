// Shared DOM rendering for lab sections — adapted from the old
// demo/browser-demo.mjs's step cards (same CSS classes, assets/style.css),
// generalized for interactive per-section "Run" buttons instead of one
// big auto-run, and a Console-Objekte hint per section (see labs/index.mjs
// for what actually lands on `window`).
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) node.appendChild(child);
  return node;
}

function renderKeyValue(result, warn = false) {
  const dl = el('dl', { class: warn ? 'kv kv-warn' : 'kv' });
  for (const [k, v] of Object.entries(result || {})) {
    dl.appendChild(el('dt', { text: k }));
    dl.appendChild(el('dd', { text: String(v) }));
  }
  return dl;
}

function renderRejection(entry) {
  const box = el('div', { class: entry.ok ? 'result-box result-rejected' : 'result-box result-fail' });
  box.appendChild(el('span', { class: entry.ok ? 'badge badge-pass' : 'badge badge-fail', text: entry.ok ? '✓ erwartete Ablehnung' : '✗ hätte abgelehnt werden müssen' }));
  box.appendChild(el('pre', { class: 'reject-msg', text: entry.error?.message || '(kein Fehler geworfen)' }));
  return box;
}

function renderResultBody(entry) {
  if (entry.expectFailure) return renderRejection(entry);
  if (!entry.ok) {
    const box = el('div', { class: 'result-box result-fail' });
    box.appendChild(el('span', { class: 'badge badge-fail', text: '✗ unerwarteter Fehler' }));
    box.appendChild(el('pre', { class: 'reject-msg', text: entry.error?.stack || String(entry.error) }));
    return box;
  }
  return renderKeyValue(entry.result, entry.kind === 'error');
}

export function renderStepCard(entry) {
  const card = el('section', { class: `step step-${entry.kind || 'info'}` });
  card.appendChild(el('h2', { text: entry.title }));
  card.appendChild(el('p', { class: 'step-desc', text: entry.description }));
  card.appendChild(el('pre', { class: 'step-code' }, [el('code', { text: entry.code })]));
  card.appendChild(renderResultBody(entry));
  return card;
}

/**
 * Renders one Lab section: heading, description, a "Ausführen" button, a
 * results container the button fills in (via runSteps from lab-runner.mjs),
 * and a hint about what lands on `window` for manual console use — the
 * whole point being that a step's code block and its `run()` are the exact
 * same code, not a narrated approximation of it.
 */
export function renderSection({ id, title, description, consoleHint }, onRun) {
  const section = el('section', { class: 'lab-section', id });
  section.appendChild(el('h2', { text: title }));
  if (description) section.appendChild(el('p', { class: 'step-desc', text: description }));

  const toolbar = el('div', { class: 'lab-toolbar' });
  const runBtn = el('button', { class: 'run-btn', text: '▶ Ausführen' });
  const status = el('span', { class: 'lab-status' });
  toolbar.append(runBtn, status);
  section.appendChild(toolbar);

  if (consoleHint) {
    section.appendChild(el('p', { class: 'console-hint', text: `Konsole: ${consoleHint}` }));
  }

  const results = el('div', { class: 'lab-results' });
  section.appendChild(results);

  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    status.textContent = 'läuft…';
    status.className = 'lab-status';
    results.textContent = '';
    let ok = 0;
    let fail = 0;
    try {
      await onRun((entry) => {
        results.appendChild(renderStepCard(entry));
        entry.ok ? ok++ : fail++;
      });
      status.textContent = `${ok} von ${ok + fail} Schritten wie erwartet` + (fail ? `, ${fail} unerwartet fehlgeschlagen` : '');
      status.className = fail ? 'lab-status warn' : 'lab-status ok';
    } catch (e) {
      status.textContent = `Abgebrochen: ${e.message}`;
      status.className = 'lab-status warn';
      console.error(`[lab:${id}]`, e);
    } finally {
      runBtn.disabled = false;
    }
  });

  return section;
}
