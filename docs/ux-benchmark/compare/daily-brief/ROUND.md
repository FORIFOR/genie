# Home daily brief — 2026-10-10

reference : Existing Genie Home and Brief golden captures, inspected 2026-10-10; DESIGN.md §1 borrows Apple/Notion's quiet reading surface, hairlines and type hierarchy. No new external product measurements are claimed.
hypothesis: Put the four requested daily subjects before the composer, using a two-column reading surface. This makes the overview available on opening Home without another question or navigation step.
measured  : Existing tokens: Home content width 760pt, large padding 24pt, card padding 18pt, body 16pt, secondary 14pt, card title 18pt. MainWindowView minimum is 940×620pt. Existing Home golden shows the composer and starter requests occupying its first viewport; no daily brief is present.
candidates: A = current Home with no brief; B = four full-width sections above the composer; C = two columns × two rows (mail/news, markets/weather), hairlines, no card shadows, existing 760pt content limit. Implement C; compare actual native captures at 940×620 and 1280×820 before accepting it.
gate      : Native synthetic fixtures must show all four section headings and useful summaries in the first viewport at normal size, preserve source/update status and partial results, and keep profile/composer access. Inspect light/dark screenshots and geometry; verify loading/empty/failure/partial/long Japanese and settings actions. Actual provider correctness is a separate root-owned check. No visual PASS is claimed before those checks.

## Scope and evidence

- This round changes Home information order and adds the explicitly requested daily reading surface. Existing color, type, spacing, width and radius tokens stay unchanged.
- Existing initial-profile and Dock work is preserved. Profile review becomes an explicit Home entry and retains the existing review/edit interface.
- `dailybrief` uses isolated temporary data, the capture day's date with fixed observation times, and synthetic content with the native production Home view. Captures are fixture evidence, not real mail, market quotes or weather.
- The preferences sheet is 500×560pt with an inner scroll area; the source detail sheet is 560×480pt. These are bounded native sheets, not changes to shared size tokens. Check their controls and long content in the same light/dark round.
- Root owns native builds, launch and actual screen verification. Implementation-time static review is not a substitute for these gates.

## Native fixture result

- Candidate C passed 48 isolated native captures on 2026-10-10: light/dark,
  940/1280 widths, ready/partial/empty/loading/failed/previous/long/location,
  denied permission and permission request during update, settings/detail/profile return.
- The native minimum host expands the requested 940×620 to 940×672. Geometry
  records both sizes, and the overview is checked against the smaller requested
  620pt height. The larger case is 1280×820. All four sections fit both bounds.
- The first fixture run exposed deferred teardown of shared probe registrations
  across windows. Explicit tree teardown fixed it; all settings and profile
  action assertions remain enabled. The corrected run has zero failures.
- Root inspected final settings and denied-permission captures. An independent
  agent inspected ready light/dark, partial and long-content captures and found
  no required visual fixes. Current golden images and geometry live in
  `docs/golden-screenshots/daily-brief/`; every image contains synthetic data.
- This is a scoped UI acceptance result, not a claim that the full repository
  acceptance suite or commercial data-provider rights have been verified.
- Live inspection found cached Work advertising subjects appearing as inferred
  actions. Home now keeps those old inferences in Work and only supplements the
  four subjects with calendar entries. Daily mail selection separately excludes
  newsletters marked IMPORTANT while respecting explicit STARRED mail.
- After shortening the settings and old-cache explanations, the new surface adds
  no over-budget long copy. `verify-ui-taste.sh` still reports the pre-existing
  content-bound review expiry for `VoiceHUD/VoiceHUDView.swift`; that unrelated
  review was not rewritten. Privacy egress, usage descriptions, type literals,
  button targets, design-token freshness and the scoped native fixtures passed.

## First fixture run

- The first native run produced the four-subject overview in light and dark appearances, but failed repeated settings/profile actions after its first window. Those entries are visible in the saved images. `UIProbe` has process-wide identifiers, so the fixture now removes the old SwiftUI tree and waits, with a limit, for its disappearance callbacks before creating the next window. Shared production probe behavior and action assertions stay unchanged. The corrected fixture still needs a native rerun.
- AppKit expanded the requested 940×620 fixture to an actual 940×672 host. Existing geometry places all overview sections above y=609.54pt. New geometry records requested and actual dimensions separately; the overview gate uses the smaller of the requested and actual heights, so expansion cannot hide an overflow beyond the 620pt target. This does not claim an actual 940×620 screenshot.

# Morning focus — 2026-10-12

reference : The owner's proposal (2026-10-12, a ChatGPT-made HTML mock `genie-morning-ui.html`, inspected as a headless render at 1440 and 390pt): a 2–3 sentence opening, today's priorities with mail-derived TODO candidates kept separate from confirmed TODOs, market values labelled with their trading day, Japan/world news with duplicates merged. Its three-column layout, right sidebar, green accent and renamed sidebar are **not** borrowed (DESIGN.md §1/§3: single-column Home, no further three-column information design, one accent).
hypothesis: The same single-column Home answers "what do I do first" if (1) a rule-made summary sits above the four subjects, (2) the existing Work card moves directly under the brief and lets the owner confirm, reject or close each mail-derived candidate in one action, and (3) every market row says which trading day it belongs to.
measured  : 2026-10-10 golden: overview bottom 574pt at 940×620 (ready), 610pt (failed). First native run of this round with a two-line summary, a second weather row and two-line market subtitles: 649.5pt (ready), 684.5pt (failed) — the overview gate failed at 940×620 in 9 states.
candidates: A = summary + 2 weather rows + 2-line market subtitles (failed the gate); B = summary only in the normal state, weather 1 row (rain advice moves into the summary when an umbrella is needed), market row = name + value + %, subtitle 1 line starting with the point change and the trading day. Implement B.
gate      : `dailybrief` selftest (48 isolated synthetic captures) with every overview section inside the first viewport at 940×620 and 1280×820; `workcontext` selftest card height < 660pt; unit tests for trading-day labels, story merging, summary rules, confirm semantics and rejected profile items; live public-source compose. Result: B passed — overview bottoms 564–602pt at 940×620; Work card 616pt.

## What changed for the owner

- Opening line: 1–3 sentences from schedule, Work's "needs a reply" items and rain. Never model-written; not sent to the voice conversation (it can contain event titles). Hidden on a previous day's card, while updating and after a failed update.
- Work card under the brief: each mail-derived item is tagged 「メール由来・候補」 with [出所を見る] [TODOに追加] [担当外]（読み上げは「自分の担当ではない」） [対応済み]. 「TODOに追加」 stores a `confirm` correction and the item stays as 「登録済み」; the other two hide it (as before, `dismiss` with note `not_mine`, and `done`). This reverses the 2026-10-10 choice to keep cached Work inferences off Home: the inferences now appear only as labelled candidates that require the owner's action, with their sources one click away.
- Markets: 「前営業日 10/9(金)の終値」 before the session, 「取引中」 during it, 「本日 …の終値」 after it; change from the provider's previous daily close (omitted when the provider does not return it). Index symbols must be the provider's INDEX instrument, so futures are never mixed in.
- News: NHK main (labelled 主要, not 国内, because it carries world stories) and NHK world are always present; the owner's topics are added. The same story from several outlets becomes one row (「NHK ほか1媒体」); different numbers never merge.
- Profile review: each guessed item has 「保存しない」; removed items stay removed after re-analysis (stored on this Mac, compared ignoring width/case). Items the owner types back in an explicit edit win over the removal.

# Readable morning brief — 2026-10-12 (afternoon)

reference : The owner's screenshot of the live Home (2026-10-12 15:37) with the request 「もっと読みやすくできませんか？」. Observed on it: the opening named a promotional mail as the first thing to do; the sender appeared twice per mail row (in the headline and the subtitle) and two TestFlight builds took both mail rows; news headlines started with 「［国際］」/「［主要］」 and repeated 「NHK」 under each row; each market subtitle ended in a truncated 「参考値（遅延の可能性）・観測 <ISO>…」; the weather row read 「25.5°/16.2°」 with no high/low; Work rows repeated the subject as both project label and title and repeated 「今日が期限」 under a 10/7 due date.
hypothesis: Removing repeated words and moving fixed notes to the place they apply once makes each row readable at a glance, without changing the layout: headline = the thing itself, subtitle = who/where/which day, section footer = source and caveats.
measured  : Before (fixture without news subtitles, the shape the live data did not match): overview bottom 564–602pt at 940×620. With live-shaped news subtitles at the secondary size: 624pt — outside the first viewport in 8 states.
candidates: A = live-shaped rows, subtitles at secondary (14pt) for mail/news and micro (12pt) for markets (failed, 624pt); B = every subtitle at micro (12pt), the same step as the market rows and the source line. Implement B.
gate      : `dailybrief` selftest 48 captures, every overview section inside 940×620 and 1280×820 — B passed, bottom 619.5pt at 940×620 (0.5pt margin; a third headline line or a second summary line at 940 will need another round); `workcontext` selftest 616pt; agent-host 533 / contracts 236 / Swift 423 tests.

## What changed for the owner

- Opening: only an item the owner confirmed as a TODO is named (「TODOが1件、まず「…」から。」). Unconfirmed mail-derived items are counted only (「メールからTODOの候補がN件見つかっています。」), so an advertisement can no longer be the first thing Home tells you to do.
- Mail: the headline is the subject only; the sender is in the subtitle. Subjects from the same sender that differ only in numbers (build numbers, dates) become one row with 「ほかN件」.
- News: the headline is the article title only; 「主要 · NHK」「国際 · NHK ほか1媒体」 in the subtitle.
- Markets: subtitle = 前日比 · which trading day · observation time in the owner's time zone (「観測 10/9 15:30」). 「参考値・遅延の可能性」 is stated once, in the section's source line.
- Weather: 「最高25.5° 最低16.2°」.
- Work card: the project label is hidden when it repeats the title; the top reason is hidden when the status line already says it; when the Work analysis is not from today the header says 「… から M/d 時点で整理」, so a 「今日が期限」 written on an earlier day is not read as today.
