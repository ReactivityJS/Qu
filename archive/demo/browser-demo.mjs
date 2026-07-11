// Visual presentation of demo/steps.mjs for the browser. Contains no QU
// logic itself — just DOM rendering per step's `kind`.
import { steps } from './steps.mjs';
import { runSteps } from './run-steps.mjs';

function el(tag, props = {}, children = []) {
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

function renderChat(result) {
  return el('div', { class: 'chat-bubble' }, [
    el('div', { class: 'chat-meta' }, [
      el('b', { text: result.from }),
      document.createTextNode(' → '),
      el('b', { text: result.to }),
    ]),
    el('div', { class: 'chat-text', text: result.text ?? '(kein Text)' }),
    ...(result.via ? [el('div', { class: 'chat-via', text: result.via })] : []),
  ]);
}

function renderFile(result) {
  const ok = result['Byte-identisch nach Transfer'];
  return el('div', { class: 'file-card' }, [
    el('div', { class: 'file-icon', text: '📄' }),
    el('div', {}, [
      el('div', { class: 'file-name', text: result['Datei'] ?? '' }),
      el('div', { class: 'file-meta', text: `${result['Chunks']} Chunk(s) · ${result['Größe (Bytes)']} Bytes` }),
      el('div', { class: `file-integrity ${ok ? 'ok' : 'bad'}`, text: ok ? '✓ Byte-identisch nach Transfer' : '✗ unterschiedlich!' }),
    ]),
  ]);
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
  if (entry.kind === 'chat') return renderChat(entry.result);
  if (entry.kind === 'file') return renderFile(entry.result);
  return renderKeyValue(entry.result, entry.kind === 'error');
}

function renderStep(entry) {
  const card = el('section', { class: `step step-${entry.kind}` });
  card.appendChild(el('h2', { text: entry.title }));
  card.appendChild(el('p', { class: 'step-desc', text: entry.description }));
  card.appendChild(el('pre', { class: 'step-code' }, [el('code', { text: entry.code })]));
  card.appendChild(renderResultBody(entry));
  return card;
}

export async function renderDemo(container) {
  container.textContent = '';
  const summary = el('div', { id: 'demo-summary', text: 'Läuft…' });
  container.appendChild(summary);

  let ok = 0;
  let fail = 0;
  await runSteps(steps, (entry) => {
    container.appendChild(renderStep(entry));
    entry.ok ? ok++ : fail++;
    summary.textContent = `${ok} von ${ok + fail} Schritten wie erwartet` + (fail ? `, ${fail} unerwartet fehlgeschlagen` : '');
    summary.className = fail ? 'warn' : 'ok';
  });
}
