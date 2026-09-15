# QuickNote backend — deployment

This is a Google Apps Script Web App. It runs under your own Google
account, so there's no OAuth app to get verified and no CASA security
assessment to pay for — it only ever touches your own Gmail, Contacts,
Sheets, and Drive. See `../SPEC.md` for why this design was chosen.

I (the assistant) cannot deploy this for you — it requires your Google
account and your own Gemini API key. Everything below is exact, but you
have to click through it yourself.

## 1. Create the Apps Script project

1. Go to [script.google.com](https://script.google.com) → **New project**.
2. Rename it to `QuickNote Backend` (top left, "Untitled project").
3. Delete the placeholder `Code.gs` contents and paste in this repo's
   `backend/Code.gs`.

## 2. Enable the advanced services this code uses

The code calls `People.People.Connections.list(...)` and
`Gmail.Users.Threads.list(...)` — both are **advanced services**, off by
default, separate from the `GmailApp` you might already know.

In the editor's left sidebar: **Services** → **+** →
- Add **People API**, keep identifier `People`, version `v1`.
- Add **Gmail API**, keep identifier `Gmail`, version `v1`.

(Equivalent to pasting this repo's `backend/appsscript.json` over your
project's manifest via **Project Settings → Show "appsscript.json" manifest
file** — either path works, the Services UI is easier if you're doing this
by hand.)

## 3. Run the one-time setup function

1. In the function dropdown at the top of the editor, select
   `runInitialSetup`.
2. Click **Run**. Google will ask you to authorize — this is your own
   script asking for access to your own Sheets/Drive/Gmail/Contacts, so
   click through the "unverified app" warning (Advanced → Go to QuickNote
   Backend (unsafe) → Allow). This warning is normal for a personal script
   only you will ever run; it's not a sign anything is wrong.
3. Open **View → Logs** (or **Executions**). You'll see:
   - a link to the new "QuickNote Data" Google Sheet it created
   - a link to the new "QuickNote Call Audio" Drive folder
   - a generated **access token** — copy this, you'll paste it into the
     app's Settings screen later.

## 4. Add your Gemini API key

1. Get a key from [Google AI Studio](https://aistudio.google.com/apikey)
   if you don't have one — it's free to start.
2. In the Apps Script editor: **Project Settings** (gear icon) → **Script
   Properties** → **Add script property**.
3. Key: `GEMINI_API_KEY`, Value: your key. Save.

Optional: if Gemini calls ever start failing with a 404 on the model name,
the model id may have been retired — check
[AI Studio](https://aistudio.google.com) for the current recommended model
id and add a script property `GEMINI_MODEL` with that value (defaults to
`gemini-flash-latest` if unset).

## 5. Deploy as a Web App

1. Top right: **Deploy** → **New deployment**.
2. Click the gear next to "Select type" → **Web app**.
3. Description: anything. **Execute as: Me**. **Who has access: Anyone**.
   ("Anyone" here just means the URL doesn't require a Google login to
   reach it — your own token check inside the code is what actually gates
   access, since the frontend is a public GitHub Pages URL with no secrets
   of its own.)
4. Click **Deploy**, authorize again if asked.
5. Copy the **Web app URL** (ends in `/exec`).

## 6. Connect the frontend

Open the QuickNote PWA → Settings (gear icon, top right) → paste:
- **Apps Script Web App URL** — the `/exec` URL from step 5
- **Access Token** — the token from step 3

Tap **Save**, then **Pull Contacts Now** to do the first Google Contacts
import.

## 7. (Optional) Schedule the Gmail correspondent scan

`indexGmailCorrespondents_()` finds people you email regularly who aren't
in Contacts yet, and suggests them. It's not called automatically — wire
it up if you want it running in the background:

1. In the editor: clock icon (**Triggers**) → **+ Add Trigger**.
2. Function: `indexGmailCorrespondents_`. Event source: **Time-driven**.
   Type: **Day timer**, whatever hour you like (e.g. 3am–4am).
3. Save, authorize if asked.

It's written to pick up where it left off across runs (tracked in Script
Properties), since a full mailbox scan can exceed the ~6-minute execution
limit on a single run. Running it once manually from the editor first is a
reasonable way to confirm it works before scheduling it.

## What's genuinely untested here

I wrote and syntax-checked this code, but I cannot execute Apps Script
locally — it depends on Google's own runtime (`SpreadsheetApp`, `GmailApp`,
`People`, `Gmail`, `DriveApp` don't exist outside Apps Script). The first
real test of `runInitialSetup()`, the Gemini calls, and the Contacts/Gmail
pulls happens when you run it in your own project. If something errors,
paste the exact error back and I'll fix it — Apps Script errors are
usually specific enough to diagnose from the message alone.
