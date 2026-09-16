/**
 * QuickNote backend — Google Apps Script Web App.
 *
 * Runs entirely under the deploying Google account. No OAuth consent
 * screen, no third-party verification, no CASA assessment — because it
 * never touches anyone's data but the account owner's own Gmail,
 * Contacts, Sheets, and Drive. See SPEC.md in the repo for the full
 * design this implements.
 *
 * ONE-TIME SETUP (see backend/README.md for the full walkthrough):
 *   1. Create a new Apps Script project, paste this file in as Code.gs.
 *   2. Enable the "People API" advanced service (Services > + in the
 *      left sidebar), OR paste appsscript.json's content via
 *      Project Settings > "Show appsscript.json manifest file".
 *   3. Run runInitialSetup() once from the editor (select it in the
 *      function dropdown, click Run). Authorize when prompted. It will:
 *        - create a "QuickNote Data" Google Sheet with the right tabs
 *        - create a "QuickNote Call Audio" Drive folder
 *        - generate an access token
 *        - print all three in the execution log (View > Logs)
 *   4. Set your Gemini API key: Project Settings > Script Properties >
 *      add GEMINI_API_KEY = <your key from Google AI Studio>.
 *   5. Deploy > New deployment > type "Web app" > Execute as "Me",
 *      Who has access "Anyone". Copy the deployment URL.
 *   6. Paste the deployment URL + token into the app's Settings screen.
 */

// ---------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------

function runInitialSetup() {
  const props = PropertiesService.getScriptProperties();

  if (!props.getProperty('SHEET_ID')) {
    const ss = SpreadsheetApp.create('QuickNote Data');
    props.setProperty('SHEET_ID', ss.getId());
    setupNotesSheet_(ss);
    setupPeopleSheet_(ss);
    Logger.log('Created spreadsheet: ' + ss.getUrl());
  } else {
    Logger.log('Spreadsheet already exists: ' + SpreadsheetApp.openById(props.getProperty('SHEET_ID')).getUrl());
  }

  if (!props.getProperty('DRIVE_FOLDER_ID')) {
    const folder = DriveApp.createFolder('QuickNote Call Audio');
    props.setProperty('DRIVE_FOLDER_ID', folder.getId());
    Logger.log('Created Drive folder: ' + folder.getUrl());
  }

  if (!props.getProperty('APP_TOKEN')) {
    const token = Utilities.getUuid().replace(/-/g, '');
    props.setProperty('APP_TOKEN', token);
    Logger.log('Generated access token (copy this into the app Settings screen): ' + token);
  } else {
    Logger.log('Access token already set (find it in Project Settings > Script Properties if you lost it).');
  }

  if (!props.getProperty('GEMINI_API_KEY')) {
    Logger.log('IMPORTANT: GEMINI_API_KEY is not set yet. Add it in Project Settings > Script Properties before saving any notes — enrichment will fail without it.');
  }

  Logger.log('Setup check complete. See the lines above for anything still needed.');
}

function setupNotesSheet_(ss) {
  const sheet = ss.insertSheet('Notes');
  ss.deleteSheet(ss.getSheetByName('Sheet1'));
  sheet.appendRow([
    'id', 'created_at', 'type', 'person_id', 'person_name', 'raw_text',
    'structured_json', 'summary', 'transcript_full', 'audio_url',
    'gmail_snapshot_json',
  ]);
  sheet.setFrozenRows(1);
}

function setupPeopleSheet_(ss) {
  const sheet = ss.insertSheet('People');
  sheet.appendRow(['id', 'name', 'email', 'phone', 'source', 'linked_contact', 'last_contact_gmail']);
  sheet.setFrozenRows(1);
}

// ---------------------------------------------------------------------
// HTTP entry points
// ---------------------------------------------------------------------

function doGet(e) {
  try {
    const action = e.parameter.action;
    requireToken_(e.parameter.token);

    if (action === 'ping') return jsonOut_({ ok: true });
    if (action === 'people') return jsonOut_({ people: handlePeopleGet_() });

    return errorOut_('Unknown action: ' + action);
  } catch (err) {
    return errorOut_(err.message);
  }
}

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    requireToken_(payload.token);

    switch (payload.action) {
      case 'note': return jsonOut_(handleNewNote_(payload));
      case 'call': return jsonOut_(handleCallIngest_(payload));
      case 'newPerson': return jsonOut_(handleNewPerson_(payload));
      case 'syncContacts': return jsonOut_(handleSyncContacts_());
      default: return errorOut_('Unknown action: ' + payload.action);
    }
  } catch (err) {
    return errorOut_(err.message);
  }
}

function requireToken_(token) {
  const expected = PropertiesService.getScriptProperties().getProperty('APP_TOKEN');
  if (!expected) throw new Error('Server has no APP_TOKEN configured — run runInitialSetup() first.');
  if (token !== expected) throw new Error('Invalid token.');
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function errorOut_(message) {
  return ContentService.createTextOutput(JSON.stringify({ error: message })).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------
// People
// ---------------------------------------------------------------------

function getPeopleSheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('Not set up yet — run runInitialSetup() first.');
  return SpreadsheetApp.openById(id).getSheetByName('People');
}

function getNotesSheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('Not set up yet — run runInitialSetup() first.');
  return SpreadsheetApp.openById(id).getSheetByName('Notes');
}

function sheetRowsAsObjects_(sheet) {
  const values = sheet.getDataRange().getValues();
  const headers = values.shift();
  return values.map((row) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}

function handlePeopleGet_() {
  return sheetRowsAsObjects_(getPeopleSheet_()).map((p) => ({
    id: String(p.id),
    name: p.name,
    email: p.email,
    phone: p.phone,
    source: p.source,
    linkedContact: p.linked_contact,
  }));
}

function handleNewPerson_(payload) {
  const sheet = getPeopleSheet_();
  const id = 'p_' + Utilities.getUuid().slice(0, 8);
  sheet.appendRow([id, payload.name || '', payload.email || '', payload.phone || '', 'manual_unlinked', false, '']);
  return { id };
}

function findPersonById_(personId) {
  return sheetRowsAsObjects_(getPeopleSheet_()).find((p) => String(p.id) === String(personId));
}

function findPersonByPhone_(phone) {
  const normalized = String(phone || '').replace(/\D/g, '');
  if (!normalized) return null;
  return sheetRowsAsObjects_(getPeopleSheet_()).find(
    (p) => String(p.phone || '').replace(/\D/g, '') === normalized
  );
}

/**
 * Pulls Google Contacts via the People API advanced service and upserts
 * them into the People sheet. Fast (a few seconds even for a few thousand
 * contacts) — this is the layer that's instant, unlike the Gmail
 * correspondent scan below.
 */
function handleSyncContacts_() {
  const sheet = getPeopleSheet_();
  const existingRows = sheetRowsAsObjects_(sheet);
  const byEmail = new Map(existingRows.map((r) => [String(r.email || '').toLowerCase(), r]));

  let pageToken = null;
  let imported = 0;
  do {
    const response = People.People.Connections.list('people/me', {
      pageSize: 200,
      pageToken: pageToken,
      personFields: 'names,emailAddresses,phoneNumbers',
    });
    (response.connections || []).forEach((person) => {
      const name = (person.names && person.names[0] && person.names[0].displayName) || '';
      const email = (person.emailAddresses && person.emailAddresses[0] && person.emailAddresses[0].value) || '';
      const phone = (person.phoneNumbers && person.phoneNumbers[0] && person.phoneNumbers[0].value) || '';
      if (!name) return;

      const key = email.toLowerCase();
      if (key && byEmail.has(key)) return; // already present, don't duplicate

      const id = 'c_' + Utilities.getUuid().slice(0, 8);
      sheet.appendRow([id, name, email, phone, 'contacts', true, '']);
      if (key) byEmail.set(key, { id, name, email, phone });
      imported++;
    });
    pageToken = response.nextPageToken;
  } while (pageToken);

  return { imported };
}

/**
 * Background correspondent-suggestion scan. Finds people you've exchanged
 * mail with (both directions, 2+ messages) who aren't in Contacts yet.
 *
 * IMPORTANT: Apps Script consumer accounts get ~6 minutes of execution
 * time per run. This function is written to stay well under that and to
 * be safely re-run repeatedly (e.g. via a daily time-driven trigger) —
 * it tracks progress in Script Properties and picks up where it left off
 * rather than assuming it can scan your whole mailbox in one pass.
 *
 * Default window: last 12 months (see SPEC.md open item #2 — change the
 * query below if you want a different range).
 */
function indexGmailCorrespondents_() {
  const START_BUDGET_MS = 5 * 60 * 1000; // stay under the ~6 min cap
  const start = Date.now();
  const props = PropertiesService.getScriptProperties();

  const query = 'newer_than:12m -in:chats';
  let pageToken = props.getProperty('GMAIL_INDEX_PAGE_TOKEN') || null;

  const existing = sheetRowsAsObjects_(getPeopleSheet_());
  const byEmail = new Map(existing.map((r) => [String(r.email || '').toLowerCase(), r]));
  const counts = new Map(); // email -> { name, count, lastDate }

  while (Date.now() - start < START_BUDGET_MS) {
    const page = Gmail.Users.Threads.list('me', { q: query, maxResults: 50, pageToken: pageToken });
    (page.threads || []).forEach((threadMeta) => {
      const thread = GmailApp.getThreadById(threadMeta.id);
      const messages = thread.getMessages();
      let sentByMe = false;
      let receivedFromOther = false;
      const others = new Map();

      messages.forEach((msg) => {
        const from = msg.getFrom();
        if (isMyAddress_(from)) {
          sentByMe = true;
        } else {
          receivedFromOther = true;
          const email = extractEmail_(from);
          const name = extractName_(from);
          if (email) others.set(email.toLowerCase(), name);
        }
      });

      if (sentByMe && receivedFromOther) {
        others.forEach((name, email) => {
          const entry = counts.get(email) || { name, count: 0 };
          entry.count += 1;
          counts.set(email, entry);
        });
      }
    });

    pageToken = page.nextPageToken;
    if (!pageToken) break;
  }

  props.setProperty('GMAIL_INDEX_PAGE_TOKEN', pageToken || '');

  const sheet = getPeopleSheet_();
  let suggested = 0;
  counts.forEach((entry, email) => {
    if (entry.count < 2) return; // require 2+ exchanged messages, kills one-off noise
    if (byEmail.has(email)) return; // already a contact or already suggested
    const id = 'g_' + Utilities.getUuid().slice(0, 8);
    sheet.appendRow([id, entry.name || email, email, '', 'gmail_suggested', false, '']);
    byEmail.set(email, { id });
    suggested++;
  });

  return { suggested, finishedFullPass: !pageToken };
}

function isMyAddress_(fromHeader) {
  const myEmail = Session.getActiveUser().getEmail().toLowerCase();
  return extractEmail_(fromHeader).toLowerCase() === myEmail;
}

function extractEmail_(header) {
  const match = String(header || '').match(/<(.+?)>/);
  return match ? match[1] : String(header || '').trim();
}

function extractName_(header) {
  const match = String(header || '').match(/^"?([^"<]+)"?\s*</);
  return match ? match[1].trim() : '';
}

// ---------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------

function handleNewNote_(payload) {
  const person = payload.personId ? findPersonById_(payload.personId) : null;
  const gmailSnapshot = person && person.email ? getGmailSnapshot_(person.email) : null;

  const structured = callGeminiJson_(buildStructurePrompt_(payload.rawText, gmailSnapshot));

  const id = 'n_' + Utilities.getUuid().slice(0, 8);
  getNotesSheet_().appendRow([
    id, new Date().toISOString(), 'typed', payload.personId || '', payload.personName || '',
    payload.rawText, JSON.stringify(structured), '', '', '',
    JSON.stringify(gmailSnapshot),
  ]);

  return { id, structured, gmailSnapshot };
}

function handleCallIngest_(payload) {
  let person = payload.personId ? findPersonById_(payload.personId) : null;
  if (!person && payload.callerPhone) person = findPersonByPhone_(payload.callerPhone);

  const summary = callGemini_(buildCallSummaryPrompt_(payload.transcript));

  const id = 'n_' + Utilities.getUuid().slice(0, 8);
  getNotesSheet_().appendRow([
    id, new Date().toISOString(), 'call', person ? person.id : '', person ? person.name : (payload.callerName || 'Unassigned'),
    '', '', summary, payload.transcript || '', '', '',
  ]);

  return { id, summary, personId: person ? person.id : null, personName: person ? person.name : null };
}

function getGmailSnapshot_(email) {
  const threads = GmailApp.search(`from:${email} OR to:${email}`, 0, 5);
  if (!threads.length) return { threadCount: 0, lastContact: null, recentSubjects: [] };

  const recentSubjects = threads.map((t) => ({
    subject: t.getFirstMessageSubject(),
    date: t.getLastMessageDate().toISOString(),
  }));

  return {
    threadCount: threads.length,
    lastContact: threads[0].getLastMessageDate().toISOString(),
    recentSubjects,
  };
}

// ---------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------

function buildStructurePrompt_(rawText, gmailSnapshot) {
  const context = gmailSnapshot && gmailSnapshot.threadCount
    ? `Recent email context with this person:\n${gmailSnapshot.recentSubjects.map((s) => `- ${s.subject} (${s.date})`).join('\n')}`
    : 'No recent email context found for this person.';

  return `You are structuring a quick note a small-business owner just took about a client. Do NOT invent details that aren't in the note.

Note (verbatim): "${rawText}"

${context}

Return ONLY a JSON object, no markdown fences, with these fields:
{
  "action_item": "the single most important thing to do next, or null",
  "dates_mentioned": ["any dates or deadlines mentioned, as written"],
  "amounts_mentioned": ["any dollar amounts mentioned, as written"],
  "urgency": "low" | "medium" | "high",
  "cleaned_text": "the note with obvious dictation errors fixed, otherwise unchanged"
}`;
}

function buildCallSummaryPrompt_(transcript) {
  return `Summarize this phone call transcript for a small-business owner's records. Be concise — a few sentences, not a paragraph per topic. Then list any commitments made by either party.

Transcript:
"${transcript}"

Format:
Summary: <2-4 sentences>
Commitments: <bullet list, or "none">`;
}

function callGemini_(prompt) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error('GEMINI_API_KEY not set in Script Properties.');

  // Check Google AI Studio for the current recommended model id if this
  // ever starts returning 404 — model names get retired periodically.
  const model = PropertiesService.getScriptProperties().getProperty('GEMINI_MODEL') || 'gemini-flash-latest';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    muteHttpExceptions: true,
  });

  const body = JSON.parse(response.getContentText());
  if (response.getResponseCode() !== 200) {
    throw new Error('Gemini error: ' + (body.error ? body.error.message : response.getContentText()));
  }

  return body.candidates[0].content.parts[0].text;
}

function callGeminiJson_(prompt) {
  const text = callGemini_(prompt);
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    return { cleaned_text: text, parse_error: true };
  }
}
