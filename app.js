// QuickNote — client app logic.
//
// Core rule this file exists to enforce: saving a note NEVER waits on the
// network, Gemini, or Gmail. Everything below is built around that —
// saveNote() writes to IndexedDB and returns immediately; sync happens
// after, silently, and re-renders the note in place once enrichment comes
// back.

// ---------------------------------------------------------------------
// IndexedDB — tiny wrapper. Three stores: notes, people, meta (settings).
// ---------------------------------------------------------------------
const DB_NAME = 'quicknote';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('notes')) {
        db.createObjectStore('notes', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('people')) {
        db.createObjectStore('people', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, storeName, mode) {
  return db.transaction(storeName, mode).objectStore(storeName);
}

function dbGetAll(db, storeName) {
  return new Promise((resolve, reject) => {
    const req = tx(db, storeName, 'readonly').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbPut(db, storeName, value) {
  return new Promise((resolve, reject) => {
    const req = tx(db, storeName, 'readwrite').put(value);
    req.onsuccess = () => resolve(value);
    req.onerror = () => reject(req.error);
  });
}

function dbGet(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const req = tx(db, storeName, 'readonly').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------------
// App state (in memory, mirrored to/from IndexedDB)
// ---------------------------------------------------------------------
let db = null;
let notes = [];       // newest first
let people = [];      // Contacts ∪ Gmail-suggested, pulled from backend
let settings = { endpoint: '', token: '', lastPeopleSync: null };
let selectedPerson = null; // { id, name } or null until chosen

const els = {}; // filled in init() with getElementById lookups

function uid() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------
async function init() {
  cacheEls();
  wireEvents();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  }

  db = await openDB();

  const savedSettings = await dbGet(db, 'meta', 'settings');
  if (savedSettings) settings = { ...settings, ...savedSettings.value };
  els.endpointInput.value = settings.endpoint || '';
  els.tokenInput.value = settings.token || '';

  people = await dbGetAll(db, 'people');
  notes = (await dbGetAll(db, 'notes')).sort((a, b) => b.created_at - a.created_at);

  renderNotes();
  updateConnStatus();

  window.addEventListener('online', () => { updateConnStatus(); trySync(); });
  window.addEventListener('offline', updateConnStatus);

  // Best-effort background sync on load; never blocks rendering above.
  trySync();
}

function cacheEls() {
  [
    'connStatus', 'pendingBadge', 'openSettingsBtn',
    'personSearchInput', 'personResults', 'selectedPersonChip', 'selectedPersonName', 'clearPersonBtn',
    'noteText', 'saveNoteBtn', 'notesList', 'emptyState',
    'settingsModal', 'closeSettingsBtn', 'endpointInput', 'tokenInput',
    'saveSettingsBtn', 'pullPeopleBtn', 'retrySyncBtn', 'settingsStatus',
    'noteDetailModal', 'closeDetailBtn', 'detailPersonName', 'detailTimestamp',
    'detailRawText', 'detailStructuredWrap', 'detailStructured',
    'detailGmailWrap', 'detailGmail', 'detailPendingNote',
  ].forEach((id) => { els[id] = document.getElementById(id); });
}

function wireEvents() {
  els.personSearchInput.addEventListener('input', onPersonSearchInput);
  els.personSearchInput.addEventListener('focus', onPersonSearchInput);
  document.addEventListener('click', (e) => {
    if (!els.personResults.contains(e.target) && e.target !== els.personSearchInput) {
      els.personResults.hidden = true;
    }
  });

  els.clearPersonBtn.addEventListener('click', () => {
    selectedPerson = null;
    els.selectedPersonChip.hidden = true;
    els.personSearchInput.value = '';
    updateSaveButtonState();
  });

  els.noteText.addEventListener('input', updateSaveButtonState);
  els.saveNoteBtn.addEventListener('click', saveNote);

  els.openSettingsBtn.addEventListener('click', () => { els.settingsModal.hidden = false; });
  els.closeSettingsBtn.addEventListener('click', () => { els.settingsModal.hidden = true; });
  els.saveSettingsBtn.addEventListener('click', saveSettingsFromForm);
  els.pullPeopleBtn.addEventListener('click', () => pullPeople(true));
  els.retrySyncBtn.addEventListener('click', () => trySync(true));

  els.closeDetailBtn.addEventListener('click', () => { els.noteDetailModal.hidden = true; });
}

// ---------------------------------------------------------------------
// Person picker
// ---------------------------------------------------------------------
function onPersonSearchInput() {
  const q = els.personSearchInput.value.trim().toLowerCase();
  const matches = q
    ? people.filter((p) =>
        (p.name || '').toLowerCase().includes(q) ||
        (p.phone || '').replace(/\D/g, '').includes(q.replace(/\D/g, '')))
      .slice(0, 8)
    : people.slice(0, 8);

  renderPersonResults(matches, q);
}

function renderPersonResults(matches, query) {
  const rows = [];

  rows.push(`
    <button data-action="new" class="w-full text-left px-3 py-2.5 text-sm text-blue-400 hover:bg-neutral-800 flex items-center gap-2 border-b border-subtle">
      <span>+</span><span>New / Unknown${query ? `: "${escapeHtml(query)}"` : ''}</span>
    </button>
  `);

  matches.forEach((p) => {
    rows.push(`
      <button data-action="select" data-id="${p.id}" class="w-full text-left px-3 py-2.5 text-sm text-white hover:bg-neutral-800 flex flex-col">
        <span>${escapeHtml(p.name || '(no name)')}</span>
        <span class="text-xs text-neutral-500">${escapeHtml(p.phone || p.email || '')}${p.source === 'gmail_suggested' ? ' · suggested from Gmail' : ''}</span>
      </button>
    `);
  });

  els.personResults.innerHTML = rows.join('');
  els.personResults.hidden = false;

  els.personResults.querySelectorAll('button[data-action="select"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const person = people.find((p) => p.id === btn.dataset.id);
      choosePerson(person);
    });
  });
  els.personResults.querySelector('button[data-action="new"]').addEventListener('click', () => {
    promptNewPerson(query);
  });
}

function choosePerson(person) {
  selectedPerson = { id: person.id, name: person.name };
  els.selectedPersonName.textContent = person.name;
  els.selectedPersonChip.hidden = false;
  els.personSearchInput.value = '';
  els.personResults.hidden = true;
  updateSaveButtonState();
  els.noteText.focus();
}

async function promptNewPerson(prefillName) {
  const name = prompt('Name:', prefillName || '');
  if (!name) return;
  const phone = prompt('Phone number (optional):', '') || '';

  const person = {
    id: `local-${uid()}`,
    name,
    phone,
    email: '',
    source: 'manual_unlinked',
    linkedContact: false,
  };
  people.unshift(person);
  await dbPut(db, 'people', person);
  choosePerson(person);

  // Best-effort: tell the backend about this new person so it lands in
  // the canonical People sheet too. Not blocking, and fine to fail
  // silently offline — it stays local-only until the next successful
  // sync picks it up via the queued 'newPerson' flag below.
  person._pendingPersonSync = true;
  await dbPut(db, 'people', person);
  trySync();
}

function updateSaveButtonState() {
  const hasText = els.noteText.value.trim().length > 0;
  els.saveNoteBtn.disabled = !(hasText && selectedPerson);
}

// ---------------------------------------------------------------------
// Save note — LOCAL FIRST. This is the one function that must never
// await a network call before returning control to the UI.
// ---------------------------------------------------------------------
async function saveNote() {
  const rawText = els.noteText.value.trim();
  if (!rawText || !selectedPerson) return;

  const note = {
    id: uid(),
    created_at: Date.now(),
    type: 'typed',
    personId: selectedPerson.id,
    personName: selectedPerson.name,
    rawText,
    structured: null,
    gmailSnapshot: null,
    syncStatus: 'pending', // 'pending' | 'synced' | 'error'
  };

  notes.unshift(note);
  await dbPut(db, 'notes', note); // local write — this is the durability guarantee
  renderNotes();

  // Reset the capture form immediately; the user is free to move on.
  els.noteText.value = '';
  selectedPerson = null;
  els.selectedPersonChip.hidden = true;
  updateSaveButtonState();

  trySync(); // fire and forget
}

// ---------------------------------------------------------------------
// Sync — everything past this point is best-effort and never blocks
// capture. Failures leave notes in 'pending' state to retry later.
// ---------------------------------------------------------------------
async function saveSettingsFromForm() {
  settings.endpoint = els.endpointInput.value.trim();
  settings.token = els.tokenInput.value.trim();
  await dbPut(db, 'meta', { key: 'settings', value: settings });
  els.settingsStatus.textContent = 'Saved.';
  trySync();
  pullPeople();
}

function backendConfigured() {
  return Boolean(settings.endpoint && settings.token);
}

async function backendPost(action, payload) {
  const res = await fetch(settings.endpoint, {
    method: 'POST',
    // IMPORTANT: text/plain avoids a CORS preflight (OPTIONS) request,
    // which Apps Script web apps do not handle by default. The body is
    // still well-formed JSON; the server parses it from e.postData.contents.
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, token: settings.token, ...payload }),
  });
  if (!res.ok) throw new Error(`Backend returned ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

async function backendGet(action, params = {}) {
  const url = new URL(settings.endpoint);
  url.searchParams.set('action', action);
  url.searchParams.set('token', settings.token);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Backend returned ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

async function trySync(manual = false) {
  updateConnStatus();
  if (!navigator.onLine || !backendConfigured()) {
    if (manual) els.settingsStatus.textContent = !navigator.onLine
      ? 'Offline — will retry automatically.'
      : 'Set the endpoint URL and token first.';
    return;
  }

  // 1. Push any locally-created unlinked people first, so notes that
  //    reference them can resolve to a real backend id.
  const pendingPeople = people.filter((p) => p._pendingPersonSync);
  for (const person of pendingPeople) {
    try {
      const result = await backendPost('newPerson', {
        name: person.name, phone: person.phone,
      });
      // Reconcile local id with the canonical backend id.
      const oldId = person.id;
      person.id = result.id;
      person.source = 'manual_unlinked';
      delete person._pendingPersonSync;
      await dbPut(db, 'people', person);
      notes.filter((n) => n.personId === oldId).forEach((n) => { n.personId = person.id; });
      for (const n of notes.filter((n) => n.personId === person.id)) await dbPut(db, 'notes', n);
    } catch (err) {
      console.warn('Person sync failed, will retry:', err);
    }
  }

  // 2. Push pending notes.
  const pending = notes.filter((n) => n.syncStatus === 'pending' || n.syncStatus === 'error');
  for (const note of pending) {
    try {
      const action = note.type === 'call' ? 'call' : 'note';
      const result = await backendPost(action, {
        personId: note.personId,
        personName: note.personName,
        rawText: note.rawText,
        type: note.type,
      });
      note.structured = result.structured || null;
      note.summary = result.summary || null;
      note.gmailSnapshot = result.gmailSnapshot || null;
      note.syncStatus = 'synced';
      await dbPut(db, 'notes', note);
    } catch (err) {
      console.warn('Note sync failed, will retry:', err);
      note.syncStatus = 'error';
      await dbPut(db, 'notes', note);
    }
  }

  renderNotes();
  if (manual) els.settingsStatus.textContent = 'Sync complete.';
}

async function pullPeople(manual = false) {
  if (!navigator.onLine || !backendConfigured()) {
    if (manual) els.settingsStatus.textContent = 'Set the endpoint and token first.';
    return;
  }
  try {
    const result = await backendGet('people');
    const byId = new Map(people.map((p) => [p.id, p]));
    (result.people || []).forEach((p) => byId.set(p.id, { ...byId.get(p.id), ...p }));
    people = Array.from(byId.values());
    for (const p of people) await dbPut(db, 'people', p);

    settings.lastPeopleSync = Date.now();
    await dbPut(db, 'meta', { key: 'settings', value: settings });

    if (manual) els.settingsStatus.textContent = `Pulled ${result.people?.length ?? 0} contacts.`;
  } catch (err) {
    console.warn('Pull people failed:', err);
    if (manual) els.settingsStatus.textContent = `Failed: ${err.message}`;
  }
}

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------
function updateConnStatus() {
  const pendingCount = notes.filter((n) => n.syncStatus === 'pending' || n.syncStatus === 'error').length;
  els.connStatus.className = 'status-dot ' + (!navigator.onLine ? 'offline' : pendingCount ? 'pending' : 'online');
  els.connStatus.title = !navigator.onLine ? 'Offline' : pendingCount ? `${pendingCount} note(s) syncing` : 'Online';

  if (pendingCount > 0) {
    els.pendingBadge.hidden = false;
    els.pendingBadge.textContent = `${pendingCount} pending`;
  } else {
    els.pendingBadge.hidden = true;
  }
}

function renderNotes() {
  els.emptyState.hidden = notes.length > 0;
  els.notesList.innerHTML = notes.map(noteRowHtml).join('');

  els.notesList.querySelectorAll('[data-note-id]').forEach((rowEl) => {
    rowEl.addEventListener('click', () => openNoteDetail(rowEl.dataset.noteId));
  });

  updateConnStatus();
}

function noteRowHtml(note) {
  const statusDot = {
    pending: '<span class="status-dot pending inline-block"></span>',
    error: '<span class="status-dot" style="background:#ef4444" title="Failed, will retry"></span>',
    synced: '',
  }[note.syncStatus] || '';

  const preview = (note.rawText || '').slice(0, 140);

  return `
    <div data-note-id="${note.id}" class="panel-bg border border-subtle rounded-lg p-3 cursor-pointer active:scale-[0.99] transition-transform">
      <div class="flex items-center justify-between mb-1">
        <span class="text-sm font-semibold text-white">${escapeHtml(note.personName || 'Unassigned')}</span>
        <div class="flex items-center gap-1.5">
          ${statusDot}
          <span class="text-[11px] text-neutral-500">${timeAgo(note.created_at)}</span>
        </div>
      </div>
      <p class="text-xs text-neutral-400 line-clamp-2">${escapeHtml(preview)}</p>
    </div>
  `;
}

function openNoteDetail(noteId) {
  const note = notes.find((n) => n.id === noteId);
  if (!note) return;

  els.detailPersonName.textContent = note.personName || 'Unassigned';
  els.detailTimestamp.textContent = new Date(note.created_at).toLocaleString();
  els.detailRawText.textContent = note.rawText;

  if (note.structured || note.summary) {
    els.detailStructuredWrap.hidden = false;
    els.detailStructured.textContent = note.summary
      ? note.summary
      : JSON.stringify(note.structured, null, 2);
  } else {
    els.detailStructuredWrap.hidden = true;
  }

  if (note.gmailSnapshot && note.gmailSnapshot.threadCount > 0) {
    els.detailGmailWrap.hidden = false;
    const s = note.gmailSnapshot;
    els.detailGmail.innerHTML = `
      <div>${s.threadCount} thread(s), last contact ${s.lastContact ? new Date(s.lastContact).toLocaleDateString() : 'unknown'}</div>
      ${(s.recentSubjects || []).map((r) => `<div class="pl-2 border-l border-subtle">${escapeHtml(r.subject)} — ${escapeHtml(r.date)}</div>`).join('')}
    `;
  } else {
    els.detailGmailWrap.hidden = true;
  }

  els.detailPendingNote.textContent = note.syncStatus === 'synced'
    ? ''
    : note.syncStatus === 'error'
      ? 'Sync failed — will retry automatically when online.'
      : 'Not yet synced — structured fields and Gmail context will appear once synced.';

  els.noteDetailModal.hidden = false;
}

// ---------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

document.addEventListener('DOMContentLoaded', init);
