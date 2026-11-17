# Daily brief data flow

## Mac experience and schedule

Home opens with a 1–3 sentence summary (schedule, items that need a reply, rain —
rule-made, never by a model) above a two-column overview of mail, news, market prices
and weather. Each section keeps its own source, update time and availability; the
detail sheet contains the remaining rows and original links. Confirmed calendar
entries can appear below. The Work card follows the brief: mail-derived items are
shown as labelled candidates (「メール由来・候補」) and become TODOs only when the owner
presses 「TODOに追加」; 「担当外」 and 「対応済み」 hide them
(see `docs/ux-benchmark/compare/daily-brief/ROUND.md`, 2026-10-12). Profile review
remains available from an explicit Home entry. The overview never approves the
inferred profile.

Market rows name the trading day of the value (「前営業日 10/9(金)の終値」 before
the session, 「取引中」 during it) and the change from the provider's previous daily
close. News always includes NHK main and NHK world headlines plus the owner's topics;
the same story from several outlets is shown once.

`BriefPreferences` defaults to 08:00 in the Mac's current time zone. The user can
change the time, news interests, symbols, current-location/manual-region mode, or
turn off scheduled refresh. Preferences and the last successful card are saved
locally with mode 0600. Saving preferences refreshes the card; cancelling does not.

While Genie is running, `BriefStore` checks once per minute and on wake. It prepares
today's card after the chosen time and catches up after sleep or a later launch;
it does not wake a shut-down Mac or backfill previous days. Failed/partial refreshes
retry no more than three times per day, at least 30 minutes apart. The manual
refresh remains available and a failed refresh preserves the previous card with
a visible warning. Preparation is quiet and does not open the Dock by itself.

Current-location weather uses an existing OS grant during scheduled work. Only
the explicit permission button may request a new grant; denied access offers the
system location settings and manual region entry. The location fix must be within
15 minutes (at most five seconds into the future), and coordinates are rounded to
two decimal places. The native app only passes device coordinates to a loopback
gateway. For a remote gateway it asks for a manually chosen region instead.
The location manager waits for its initial authorization delegate notification
before evaluating the grant, within the same ten-second request deadline. A
startup value of `notDetermined` is not treated as confirmed missing consent.
If several requests join the same location read, its shared timeout only moves
earlier, to the earliest caller deadline. Initial authorization wait cancellation
and late callbacks are covered by device-free tests of the production request path.

`brief.today` is a local, read-only task. Its `brief.compose` step produces a
`genie.brief/v1` artifact with calendar, weather, mail, attention, news and markets
sections. A task completing means the artifact is available; individual sections
can still be unavailable or partly updated.

The Mac supplies its calendar and cached Work attention items. The agent host
reads fresh mail metadata through the existing `ConnectorRuntime` while public
weather retrieval starts. Mail uses the user's existing Gmail or Outlook read
connection and `email.read` grant. The daily read does not fetch message bodies,
attachments, or call a model. Snippets/body previews returned with provider
metadata are not copied into the artifact or spoken summary.

The mail read covers the previous seven days and requests at most 100 metadata
rows across connected providers. Gmail reserves half its budget for important or
starred mail, uses the remaining budget for other incoming mail, and shares the
existing 250 ms request-start pacing and bounded rate-limit retry. Outlook reads
only Inbox. The metadata filter for advertisements and automatic notifications is
shared with Initial Profile. Daily mail additionally retains explicitly starred
mail and a narrow set of important automatic notices whose subjects indicate
payment deadlines/failures, security alerts or required identity verification.
An IMPORTANT label alone does not admit automated mail; bulk/list notices and
promotional subjects do not qualify for that exception. Spam, trash, drafts and
sent mail remain excluded even with a star. The initial-profile policy is unchanged.
Rows are deduplicated by message and then by newest thread. Direct correspondence
precedes automatic notices; within each group, stars, importance, unread status
and received time determine the order. This is metadata
selection, not a claim that message contents or required replies were analyzed.
The result states the actual fetched/displayed counts; 100 is a ceiling, not a
guarantee. Provider reads share a 45-second cancellation signal.

Each mail line carries its subject, sender, received timestamp and provider link
when available. The `talk` summary contains only counts and section status, not
subjects or senders. Cached Work attention remains a separate section.

`BriefArgs.region` optionally overrides the local default weather region.
When `BriefArgs.weather_location` is present, `ok` requires latitude and longitude
and displays weather near the device, including rain during scheduled times.
Only coordinates rounded to two decimals go to the public weather provider; event
locations are not geocoded in this mode. Location `none` (not permitted) or `stale`
(unavailable) is displayed as supplied, with no fallback to a saved region.
Omitting the field preserves the older region-based behavior. The native caller
owns OS permission and supplies the result; scheduled refresh must not prompt.
Daily forecasts request and validate the brief's exact calendar date. A different
day returned by the provider is unavailable, rather than relabeled as today's
weather. Relative-day conversational weather queries retain their existing behavior.
`BriefArgs.watchlist` optionally supplies up to eight symbol strings; an explicit
empty list disables market reads, while omission uses the adapter's reference
indices. The market section displays observed provider prices and timestamps,
not values inferred from news. Its public Yahoo chart adapter is experimental
and indicates possible delay. It can be replaced independently of composition.

All sections use `ok`, `stale`, or `none`. A successful zero-row mail read is `ok`
with a fetch timestamp. Missing connections/grants are `none`. Failed reads are
`stale`; successful rows from a partially failed read remain visible. Consumers
must not hide `lines` just because a section is `stale`.

Focused synthetic checks are in `workers/agent-host/test/brief-mail.test.ts`,
`brief.test.ts`, `markets.test.ts`, `initial-profile-mail.test.ts`, and
`services/task/test/brief-plan.test.ts`. Real mailbox reads and public-provider
availability require separate live verification; passing these fixtures alone
does not establish either.
