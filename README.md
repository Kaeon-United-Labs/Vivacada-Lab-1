# Vivacada

Vivacada is a credentialing system: an AI conducts a structured, Socratic oral exam on a subject, a proctor watches it happen, and a passing result becomes a shareable, verifiable credential. It's aimed at people who are competent but credential-poor — career-changers, self-taught practitioners, anyone who can prove they know a subject without wanting to sit through a degree program to do it.

The core model is human proctoring: rather than run its own centralized testing centers, Vivacada is **open source software that institutions self-host**, paired with a hosted registry that ties results together into portable, verifiable credentials. Public institutions like these are already trusted, publicly accountable, and already proctor exams (GED, professional certifications); Vivacada borrows that legitimacy instead of building its own from zero.

That model has a cold-start problem: it needs institutions to volunteer before anyone can earn a credential. To break that catch-22, Vivacada also runs an optional, clearly-labeled AI-proctored path directly — paid, adults-only, remote, with no human anywhere in the loop. It's a deliberately lower-trust-tier alternative, not a replacement for the human-proctored model, and every credential it produces is labeled as such everywhere the issuing institution's name appears, so the two are never confused. The bet is that a visible, honestly-labeled body of real credentials gets institutions to notice and volunteer faster than cold outreach alone.

This repository is one codebase with **three run modes**, chosen by an environment variable. They're logically separate services — you'll typically run one process per mode, many testing-kiosk instances and one AI-testing client instance pointed at one aggregator, and possibly several AI-testing worker instances behind that — but they ship together, sharing a `shared/` module for the interview engine and grading so calibration never drifts between the two testing paths.

## Quick start

```bash
npm install
cp .env.example .env
```

Set `APP_MODE` in `.env` to `testing`, `aggregator`, or `ai-testing`, fill in whatever that mode needs (see below), then:

```bash
npm start
```

To run modes side by side locally (e.g. to test a kiosk against a real aggregator instance), use separate terminals with separate `.env` files, or the convenience scripts:

```bash
npm run start:aggregator   # APP_MODE=aggregator, defaults to PORT 4000
npm run start:testing      # APP_MODE=testing, defaults to PORT 3000
npm run start:ai-testing   # APP_MODE=ai-testing, defaults to PORT 3100 — needs real MongoDB + S3, see below
```

## `APP_MODE=testing` — the exam kiosk

Self-hosted by an institution — run as a walk-up kiosk on institution premises, though any device works. No accounts of its own, no disk persistence, no payments, no remote AI proctoring. Concretely:

- A **staff unlock code** starts a session (keeps the kiosk from being hit anonymously and running up compute bills); multiple patrons can use one instance concurrently, each in their own isolated session.
- The patron enters an email and a birthdate on the same screen — the proctor is trusted to confirm the birthdate the same way they attest to the rest of the exam, no document check. The kiosk also looks up the matching aggregator account (institution-authenticated, not a public lookup) and displays the account holder's name in the top corner for the rest of the session — falling back to showing the email itself if no account exists yet. This stays on screen until the kiosk returns to the unlock screen for the next patron.
- The patron then picks a test on one of two tabs: the **main catalog** (a subject and a difficulty level, both picked from dropdowns), or **other tests** — a hidden, non-browsable "special" catalog found only by typing its exact name into an autocomplete. Special-catalog tests have no difficulty level to choose; the exam is generated entirely from that subject's admin-authored description.
- The exam itself: a fixed-length, AI-generated Socratic interview — concrete tasks mixed with conceptual questions, organized into topic threads capped at three questions each, regenerated fresh every attempt so no two exams are identical. Catalog-tier tests are level-scaled against the five fixed difficulty tiers (beginner through expert) — that taxonomy is hardcoded, never configurable per subject or per institution. Special-catalog tests never use a named tier at all: rigor is calibrated implicitly from the subject's own description (both in what questions get asked and in how they're graded), it's never named to the generating model, never mentioned in the exam or its feedback, and never transmitted to or stored by the aggregator — a special-catalog credential's record has no level field, full stop.
- On completion, the exam auto-grades. A **separate proctor code**, entered by the staff member who watched the exam, releases the result to the aggregator — this acts as the proctor's attestation, distinct from the unlock code so a compromised front-desk secret doesn't also compromise result integrity.
- If the aggregator is unreachable, the release step can be retried without re-administering the exam — nothing is lost until the aggregator confirms receipt.

Needs: `UNLOCK_CODE`, `PROCTOR_CODE`, an `INSTITUTION_API_KEY` issued by an aggregator admin, and `AGGREGATOR_ENDPOINT` pointing at it. Set `ALLOW_SPECIAL_CATALOG=false` to hide the "other tests" tab at this institution. LLM credentials are optional — with none set, exams run on a deterministic mock interviewer/scorer, useful for trying the flow but not for real assessments.

## `APP_MODE=aggregator` — the registry

Hosted, stateful, and where the actual product lives:

- **Accounts.** Email/password plus a required full name, editable later in profile settings. Both the name and email are shown on the account's public credentials. No separate email-verification step — an account with a matching email automatically attaches any exam results archived under that email, whether the match happens at signup, later via a profile edit, or before or after the account exists. Note: since email isn't verified, the name field is attribution/display only — anyone who signs up with a given email can set any name they like, so it does not by itself stop someone from claiming a result that isn't theirs. Every actual change to a name or email (not no-op re-saves) is recorded to a `profileChanges` audit collection with the old value, new value, and timestamp. The seeded admin account's name is `Admin`.
- **Catalog.** Two lists. **Main** subjects (name plus an optional description that informs — but is never required for — question generation) populate the testing app's ordinary dropdown, so "Algorithms & Data Structures" means the same thing everywhere. **Special** subjects don't appear in any dropdown — a student finds one only by typing its exact name into an autocomplete — and carry no difficulty level; the exam is generated entirely from the subject's description, so a description is required for special entries. Admins can move a subject between the two catalogs at any time. Difficulty levels themselves are never part of the catalog either way; they're a fixed constant the exam engine applies uniformly.
- **Credentials & badges.** A public, shareable page and embeddable SVG badge per credential, with student-controlled visibility and an optional public transcript, off by default.
- **Institutions.** Admins vet and approve which institutions may submit results at all — via a dashboard (cookie session, admin-only) or headlessly via `ADMIN_API_KEY`. A public, unauthenticated directory (`/api/institutions/directory`) lists approved institutions only, with no API keys or internal status exposed, so students can find where to test. Each institution can optionally carry one label, picked from the closed `INSTITUTION_LABELS` vocabulary (e.g. `AI-Proctor`) — never free text, admin-assignable only. The label shows everywhere the institution's name appears: the directory, dashboard, public credential page, and badge. A credential freezes the institution's label at the moment it's issued, the same way it freezes the institution's name and the model used — so it always describes how *that* credential was actually earned, even if the institution's current label changes later.
- **Employer matching.** A single paid revenue line: employers with a shared API key can query opted-in, publicly-visible profiles by subject and level. Age is checked per credential rather than per account — the testing app collects a birthdate on the same screen as email, proctor-witnessed the same way the rest of the exam is, and it travels with the result as credential metadata. It's never shown on the credential itself (public page, badge, or even the owner's own dashboard). Eligibility is recomputed live against that stored birthdate every time matching runs, not frozen at the moment the credential was earned: a credential from a test taken at 16 becomes eligible for matching automatically the instant today's date implies the holder has turned 18 — no re-issuing, no re-approval, nothing else has to happen. The birthdate isn't a lock; it's an audit record against lying about age at test time, and the age check is simply "is this person 18 today," asked fresh on every query.
- **Navigation.** About and Find-an-institution are reachable without logging in. The root page (`/`) doubles as the landing page: it shows About when logged out and the dashboard when logged in, but `/about` is always reachable directly either way, and About appears first in the nav (ahead of Dashboard) regardless of login state.

Needs: `ADMIN_EMAIL`/`ADMIN_PASSWORD` to seed the first admin account. `MONGODB_URI` for a real database — omit it and results persist to a local JSON file instead, fine for development.

## `APP_MODE=ai-testing` — the AI-proctored testing service

A hosted, payment-gated alternative to the kiosk: no institution, no proctor, no unlock/proctor codes — a website anyone can pay to use, adults only. From the aggregator's perspective it's just another institution, typically vetted and given the `AI-Proctor` label, submitting through the same `/api/ingest` every kiosk uses.

- **Payment gates the session.** Read the terms (`legal/terms.txt`, a real drafted document — needs actual legal review before real payments touch it), agree, pay a flat per-attempt fee via Stripe or PayPal (one active provider, chosen by `PAYMENT_PROVIDER`; `MOCK_MODE` substitutes an instant fake success for local development). The fee is identical for a first attempt and every retry — a rejection just means paying again.
- **Recording is segmented, not one continuous file.** A new clip pair (webcam + screen) starts at every step boundary: show your face, show a photo ID, perform a random gesture list (retry re-records just that step — the retry supersedes and immediately deletes the prior take, never held until the end), pan the camera around the room, then the exam itself, ending at Submit. Only the final kept clip per step is ever analyzed.
- **Grading is immediate; proctoring is separate and asynchronous.** The exam — same shared engine, same five-tier calibration as the kiosk — grades and shows a result the moment you submit. If it fails on content, everything is discarded immediately and nothing is queued. Only a passing attempt's footage goes to proctoring at all, and nothing reaches the aggregator until that separately clears — so a passing exam with rejected footage never becomes a credential.
- **One multimodal model does all of the proctoring**, in a single call per attempt: confirms a real face, reads the ID and extracts its birthdate, confirms the ID photo matches the face, checks the gestures were followed (allowing for ordinary imprecision), and reviews the room sweep and exam footage for obvious cheating signals. Every check has to pass — any one failing is an overall reject, with no reason given back to the candidate. **This is a genuinely hard task for current multimodal models and the shipped prompt has not been tuned against a real model in this environment** — expect real iteration before it's reliable.
- **Nothing is ever retained.** Every clip, ID footage included, is permanently deleted the moment analysis completes — pass or fail, approved or rejected. If approved, only the exam transcript, score, feedback, and the birthdate read off the ID travel onward to the aggregator; the footage itself never does.
- **No human anywhere in this loop**, by design, and the terms say so plainly: a false rejection is possible, isn't grounds for a refund, and costs another attempt to retry. A technical failure (model API down, malformed response) is retried automatically and is never counted as a rejection on its own — but if it can't get a clean result after `PROCTOR_MAX_JOB_ATTEMPTS` tries, the attempt still ends up failed the same way a real rejection would, and the terms say that too.
- **Scales horizontally by design.** `ROLE=client` (the default) both serves the site and processes its own proctoring queue; `ROLE=worker` runs only the queue processor, no HTTP surface at all — run several of these behind one client instance to parallelize proctoring analysis under load. Job claiming is atomic (`findOneAndUpdate` in Mongo, so two workers can never claim the same job) and lease-timed, so a crashed worker's claimed job gets reclaimed and retried automatically rather than stranding that attempt forever.
- **Requires real infrastructure, even to try it.** Unlike the other two apps, there is no local-disk demo mode here at all — `MONGODB_URI` and the `S3_*` vars are hard requirements regardless of `MOCK_MODE`, which only fakes payment and the proctoring verdict, never storage.

Needs: `MONGODB_URI`, `S3_BUCKET` (+ credentials), a payment provider configured (or `MOCK_MODE=true`), a grading `LLM_*` config (optional — mocked if absent, same as the kiosk), a `VIDEO_MODEL_*` config for real proctoring, and `AGGREGATOR_ENDPOINT` + `INSTITUTION_API_KEY` like any institution.

## What's deliberately not here

No ads, no paid test marketplace. Remote AI proctoring exists only as the clearly-labeled, paid, adults-only alternative described above — it is never the default, and a credential earned through it is never displayed as though a human watched it. The employer-matching logic is currently a simple keyword filter, not a scoring/ranking product — the natural next step if that side of the business needs to be worth paying for is splitting it into its own service against the aggregator's data, rather than growing it in place here. Kiosk age verification is proctor-attested, not document-verified; the AI-testing path verifies ID-vs-face automatically instead. A parental-consent flow for minors, beyond the hard employer-matching exclusion, is still out of scope everywhere.
