// Kontakte — die Oberfläche für src/modules/contacts.js's bereits
// fertigen, getesteten Backend-Teil (addContact/removeContact/
// listContacts/onContactsChange, installiert über createContactsPlugin()
// in qu-app-shell.mjs). Ein Kontakt-Eintrag ist rein lokal/privat
// (verschlüsselt-an-sich-selbst, siehe contacts.js's eigener Datei-
// Kommentar) — anders als das Verzeichnis (services/directory/), das
// öffentlich, opt-in und geteilt ist.
//
// Zwei Wege, einen Kontakt hinzuzufügen: das Formular unten (bekannte
// Fingerprint direkt eintragen) und der "Zu Kontakten hinzufügen"-Button
// auf jedem fremden Profil (shell/identity-screen.mjs) — beide rufen
// letztlich denselben qu.addContact() auf.

import '../../src/ui/profile-components.js'; // Seiteneffekt: registriert <qu-profile-card>
import { isValidFingerprint, buildPath } from '../../src/index.js';

export function mount(container, { qu }) {
  const heading = document.createElement('h2');
  heading.textContent = '📇 Kontakte';
  const hint = document.createElement('p');
  hint.className = 'qu-contacts-hint';
  hint.textContent = 'Nur für dich sichtbar — verschlüsselt an deine eigene Identität, niemals veröffentlicht.';

  const list = document.createElement('ul');
  list.className = 'qu-contacts-list';
  const empty = document.createElement('p');
  empty.className = 'qu-contacts-empty';
  empty.textContent = 'Noch keine Kontakte.';
  empty.hidden = true;

  const form = document.createElement('div');
  form.className = 'qu-contacts-form';
  const fpInput = document.createElement('input');
  fpInput.type = 'text';
  fpInput.placeholder = 'Fingerprint (24 Zeichen)';
  fpInput.maxLength = 24;
  const aliasInput = document.createElement('input');
  aliasInput.type = 'text';
  aliasInput.placeholder = 'Eigenes Label (optional, z. B. „Chef“)';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.textContent = 'Hinzufügen';
  const status = document.createElement('span');
  status.className = 'qu-contacts-status';
  form.append(fpInput, aliasInput, addBtn, status);

  container.append(heading, hint, list, empty, form);

  const rows = new Map(); // fingerprint -> <li>, siehe identity-screen.mjs's renderAttributesEditor() für dasselbe Patch-statt-Neubau-Muster

  function updateEmptyState() {
    empty.hidden = rows.size > 0;
  }

  function renderRow(fingerprint, contact) {
    let li = rows.get(fingerprint);
    if (!li) {
      li = document.createElement('li');
      rows.set(fingerprint, li);
      list.appendChild(li);
    }
    if (contact == null) { li.remove(); rows.delete(fingerprint); updateEmptyState(); return; }

    li.textContent = '';
    const card = document.createElement('qu-profile-card');
    card.setAttribute('fp', fingerprint);
    card.setAttribute('href', buildPath(`~${fingerprint}`));
    const label = document.createElement('span');
    label.className = 'qu-contacts-label';
    label.textContent = contact.alias ? `„${contact.alias}“` : '';
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = 'Entfernen';
    removeBtn.addEventListener('click', async () => {
      removeBtn.disabled = true;
      try {
        await qu.removeContact(fingerprint);
      } catch (e) {
        console.error('[contacts] removeContact failed:', e);
        removeBtn.disabled = false;
      }
    });
    li.append(card, label, removeBtn);
    updateEmptyState();
  }

  qu.listContacts().then((contacts) => {
    for (const c of contacts) renderRow(c.fingerprint, c);
    updateEmptyState();
  }).catch((e) => console.error('[contacts] initial listContacts failed:', e));
  // `q.value === null` ist die Tombstone-Form (contacts.js's removeContact()-
  // Doku) — `q.id`'s letztes Pfadsegment ist der Kontakt-Fingerprint.
  const offContacts = qu.onContactsChange((q) => {
    const fingerprint = q.id.slice(q.id.lastIndexOf('/') + 1);
    renderRow(fingerprint, q.value);
  });

  addBtn.addEventListener('click', async () => {
    const fingerprint = fpInput.value.trim();
    const alias = aliasInput.value.trim() || undefined;
    if (!isValidFingerprint(fingerprint)) {
      status.textContent = 'Ungültiger Fingerprint (24 Zeichen erwartet).';
      return;
    }
    addBtn.disabled = true;
    status.textContent = '';
    try {
      await qu.addContact(fingerprint, { alias });
      fpInput.value = '';
      aliasInput.value = '';
    } catch (e) {
      console.error('[contacts] addContact failed:', e);
      status.textContent = `Fehlgeschlagen: ${e.message}`;
    } finally {
      addBtn.disabled = false;
    }
  });

  return () => offContacts();
}
