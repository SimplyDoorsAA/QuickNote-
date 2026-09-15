# QuickNote — Design Spec (Draft)

Personal quick-note app for capturing client calls/notes when away from the
office. Single user. Brainstorming phase — nothing in this doc is built yet.

Status: **draft**, converged through conversation, not yet approved for build.
Anywhere marked 🤔 is a judgment call made in the absence of an explicit
answer — flag it if it's wrong and it changes fast, nothing is load-bearing
yet.

---

## 1. What this app is

- Fast capture of a note when a client calls, by typing or dictating.
- Every note gets AI structuring (Gemini) and a permanent snapshot of
  relevant Gmail context, frozen at the moment the note is taken.
- Optionally, a completed phone call recorded by iOS can be turned into a
  note (transcript + summary), via a manual share-out — not automatic.
- Single user (you). No other accounts, no write-back to any external
  business system in v1.

## 2. Explicitly out of scope (v1)

- **Service Fusion** — removed entirely per decision on [date]. No SF
  customer data, no SF job status, no SF API calls anywhere in this design.
- Any write-back to Gmail, Contacts, or any other system. Everything here
  is read-only against Google services, write-only into the app's own
  Sheet/Drive.
- Multi-user / team use.
- Native iOS app. This is a PWA (installable web app) for now — see §9 for
  why native is deferred, not rejected.

## 3. Architecture

```
iPhone (PWA, home-screen installed)                iPhone (Phone app)
 - text box, keyboard mic for dictation              - Apple's native call
 - saves note to IndexedDB INSTANTLY,                  recording (iOS 18.1+)
   before any network call                            - plays mandatory
 - background sync to Apps Script when online           recording announcement
                │                                        (cannot be disabled —
                │                                         OS-level, not app code)
                │                                     - transcript saved to Notes
                │                                            │
                │                                            │ user manually shares
                │                                            ▼
                │                                     iOS Shortcut (share sheet)
                │                                     POSTs transcript + caller
                │                                     number to same endpoint
                ▼                                            │
        ┌───────────────────────────────────────────────────┘
        ▼
  Google Apps Script Web App   (runs AS the user's own Google account —
  │                             no OAuth consent screen, no verification,
  │                             no CASA, because it only ever touches this
  │                             one person's own Gmail/Contacts/Drive/Sheets)
  │
  ├─ People API (Advanced Service) ─→ Google Contacts: name/email/phone
  ├─ GmailApp.search()             ─→ per-note thread lookup +
  │                                    background correspondent indexing
  ├─ Gemini API                    ─→ structure typed notes /
  │                                    summarize + extract from call transcripts /
  │                                    pick likely contact match, with confidence
  ├─ Google Sheet                  ─→ permanent record: Notes tab, People tab
  └─ Drive folder                  ─→ call audio (if kept, see §7)
```

Endpoint is protected by a long random shared token (stored in the PWA's
local storage, checked by Apps Script on every request) — not a full OAuth
flow, since this is a single-user tool. See §10 for why this is judged
sufficient here.

## 4. Capture flow (typed / dictated note)

1. Tap "New Note." Text box opens focused, empty. No AI in this path yet.
2. Type, or tap the iOS keyboard's built-in mic key to dictate. (The Web
   Speech API does **not** work in an installed iOS PWA — confirmed dead
   end, do not build against it. Keyboard dictation is an OS feature and
   works fine.)
3. Pick who the note is about — search-as-you-type over the People tab
   (Contacts ∪ Gmail-suggested). First row is always **"+ New / Unknown"**
   for a caller who isn't anywhere yet — takes just a name + number,
   created as a local, unlinked entry.
4. Tap save. **Note is written to IndexedDB and the UI returns immediately
   — this never waits on network, Gemini, or Gmail.** This is the single
   most important behavior in the app: capture must work with zero signal.
5. In the background, when online: note syncs to Apps Script, which:
   - looks up the selected person's recent Gmail threads
   - sends the raw note + those threads to Gemini for structuring
   - writes the enriched row to the Sheet
   - syncs the enrichment back down to the phone

Raw text is never overwritten by enrichment — it sits in its own column,
untouched, forever.

## 5. Capture flow (call recording → note)

1. You record a call using iOS's native Phone app recording feature.
   Both parties hear Apple's mandatory recording announcement — this is
   not configurable by us or by you (Settings > Apps > Phone > Call
   Recording is the only toggle, and it's all-or-nothing). This
   announcement satisfies consent under Texas's one-party-consent law
   (Tex. Penal Code §16.02) automatically, since you are a party to every
   call and the other party is also told. See §11 for the one case this
   doesn't fully cover.
2. Recording + on-device transcript land in the Notes app automatically
   (US, English, per Apple's current regional support).
3. You manually share that Notes item via an iOS Shortcut ("Add to
   QuickNote"), which POSTs the transcript (and caller info, if the share
   payload includes it — **unverified, see open item in §12**) to the
   Apps Script endpoint.
4. Apps Script attempts to match the caller to a person:
   - **Known phone number** (matches a Google Contact) → attaches
     automatically, no confirmation needed.
   - **Unknown number** → lands in an "Unassigned" tray; one tap to pick
     an existing person or create a new one. This is also the intake path
     for brand-new leads.
5. Gemini summarizes the call (call notes get **summary + extracted
   commitments up front, full transcript collapsed underneath** — inverted
   from typed notes, because a 12-minute call transcribed verbatim is not
   something you want to re-read to find the one thing that mattered).

## 6. Data model (Google Sheet)

**Notes tab** — one row per note:

| Column | Notes |
|---|---|
| `id`, `created_at`, `type` | `typed` or `call` |
| `person_id` | FK into People tab, or `unassigned` |
| `raw_text` | verbatim, never edited by AI |
| `structured` | action item / dates / amounts / specs (typed notes) |
| `summary`, `commitments` | (call notes only) |
| `transcript_full` | (call notes only, collapsed in UI) |
| `audio_url` | Drive link, if audio is kept — see §7 |
| `gmail_snapshot` | frozen at save time: thread count, last-contact date, 2–3 recent subject/date/gist lines |
| `edited_after_enrichment` | 🤔 open — see §12 |

**People tab** — one row per person:

| Column | Notes |
|---|---|
| `id`, `name`, `email`, `phone` | |
| `source` | `contacts` or `gmail_suggested` or `manual_unlinked` |
| `linked_contact` | bool — has this been confirmed/merged into a real relationship |
| `last_contact_gmail` | for the suggestion layer's own bookkeeping |

## 7. Open items — need your answer, not blocking the rest of the build

1. **Call audio: keep the file, or transcript-only?** Audio is ~1MB/min in
   Drive; transcript-only saves storage and time but loses the ability to
   re-listen to tone/exact wording on a disputed call. 🤔 assumed **keep
   audio** as the default unless told otherwise.
2. **Gmail backfill window** for the correspondent-suggestion layer — 🤔
   assumed **last 12 months**, not full history (see §3, execution-time
   constraint). Confirm or change.
3. **Notes editable after enrichment, or append-only?** Append-only is
   simpler and preserves an audit trail; editable is more forgiving of
   mistakes. Not yet decided.
4. **Photos on notes?** Not yet discussed. Would mean a Drive folder + one
   more capture step.
5. **Shortcut payload contents** — unverified what the iOS Share Sheet
   actually hands a Shortcut from a shared Notes call recording (transcript
   text? audio file? caller name? phone number?). **This needs a 5-minute
   real-device test before the call-linking design in §5 can be trusted as
   written** — if the phone number isn't in the payload, matching falls
   back to contact name (fuzzier).
6. Old Firebase project (`simplydoors-notes`) — pending confirmation to
   delete once anything worth keeping is exported. Not used by this design
   at all going forward.

## 8. Known constraints (verified, not assumptions)

- Web Speech API is dead in installed iOS PWAs. Do not build dictation on it.
- `ContactsApp` in Apps Script was shut down Jan 31, 2025. Use the People
  API advanced service instead.
- Apps Script execution cap is ~6 minutes per run on consumer accounts —
  full-history Gmail scans must be chunked/resumable, not one-shot.
- iOS PWAs cannot be Web Share Target destinations (open WebKit bug, years
  unresolved) — this is why call-recording ingestion goes through a
  Shortcut instead of the app receiving a native share directly.
- Apple's call-recording announcement cannot be disabled short of turning
  call recording off entirely. Not a setting in our control.

## 9. Why PWA now, native later

Every integration here (Gmail, Gemini keys) requires server-side credential
storage regardless of client — native buys nothing on that front. Native's
real advantages (Siri/App Intents, Lock Screen capture, robust offline,
reliable push) are real but are a v2+ concern once the capture + enrichment
loop is proven. Building native first would mean paying Swift/Xcode cost
before knowing whether the core idea (fast capture + Gmail-grounded
enrichment) is actually useful day to day.

## 10. Security posture

- No PIN-in-source theater (the old `index.html` had `APP_PIN = "1234"`
  hardcoded in a public repo — being replaced, not preserved).
- Apps Script endpoint requires a long random bearer token, generated once,
  stored in the phone's local storage. Public GitHub Pages hosting is fine
  because the page itself holds no secrets and no data — only the token,
  entered once per device, gates the API.
- No Firestore, no separate database with its own rules to get wrong —
  Sheets + Drive inherit your normal Google account permissions.

## 11. Legal note on call recording (Texas)

Texas is one-party consent (Tex. Penal Code §16.02) — your own consent as a
party to the call is sufficient under Texas law, and Apple's announcement
means the other party is told regardless. The one case this doesn't fully
resolve: a call where the other party is physically in an all-party-consent
state (CA, FL, IL, WA, others) — courts often apply the stricter state's
law across state lines. Apple's announcement still discloses the recording
in that case, which is the main legal protection either way; this is noted
for awareness, not a blocker, given announcement is always on.

## 12. Explicitly deferred / not designed yet

- Any UI/visual design — this doc is data flow and architecture only.
- Push notifications, reminders, "draft my next action" (mentioned earlier
  as a v1.something feature, low priority, build last if at all).
- Multi-device conflict resolution beyond "last write wins" — fine for a
  single user on one phone; would need real thought if that changes.
