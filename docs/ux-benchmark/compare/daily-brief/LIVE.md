# Daily brief live check — 2026-10-10

The signed `/Applications/Genie.app` was updated locally while retaining the
previous app in `.build/app-backups.noindex/daily-brief-before-20261010/`.
The existing local execution service and the existing Gmail read connection were
used. Mail subjects, senders, coordinates and credentials are excluded from this
report and from the committed synthetic screenshots.

At 12:38 JST the installed Home displayed:

| Section | Result |
| --- | --- |
| Mail | Gmail, 10 selected recent threads, `ok` |
| News | NHK, 3 headlines, `ok` |
| Markets | 3 observed index values, `ok`, observation time separate from fetch time |
| Weather | Open-Meteo, current-location forecast for the brief date, `ok` |

The first live read exposed newsletters carrying Gmail's IMPORTANT label at the
top of the overview. The daily filter was corrected and verified again with the
same account. IMPORTANT alone no longer exempts bulk mail; explicit STARRED mail
is retained, and direct correspondence ranks ahead of automatic notifications.
Payment/security/identity notices use a limited subject-based exemption. This is
metadata selection, not body analysis or a guarantee of complete prioritization.

The preferences sheet was inspected and saved: automatic refresh on, 08:00,
current-location weather on, no topic restriction, and the three default reference
indices. Preferences and the cached card have mode 0600. The Home overview and
settings were inspected in the installed app; synthetic snapshots separately
cover 48 native visual/state cases. Calendar was unavailable and was not invented.

An additional cold-start authorization-state issue was found: an early location
status read could report not-determined before the first delegate notification.
The subsequent explicit location action succeeded without an OS dialog. Its
correction waits for the initial delegate notification and uses the earliest
deadline when requests share a location read. Eleven new deterministic request
tests plus the related brief/preferences/location tests passed (25 total).

At 12:49 JST, the previous cached card was preserved under a separate local
backup name and the final signed app was cold-launched. Without pressing refresh
or the location authorization button, a new card was generated at
`2026-10-10T03:49:48.199Z`: Gmail 10 rows, NHK 3 rows, market indices 3 rows,
current-location weather 1 row, all four sections `ok`. The Home accessibility
state confirmed the four headings, the 08:00 schedule, the observed index link
and the current-location forecast. Private screen evidence remains in `/tmp`;
it is not part of the repository's golden images. This verifies launch catch-up
and existing-grant location use; it does not claim observation of tomorrow's
08:00 timer event. Timer timing and wake behavior are covered by the scoped tests.

Stock retrieval uses an experimental public Yahoo chart adapter. Observed values
are reference values and may be delayed; supported commercial redistribution is
not established by these checks. Whole-repository release acceptance is also not
claimed; see `ROUND.md` for the unrelated UI-review expiry.
