# Desktop reflection layout

## Completed-journey editing follow-up

The completed state incorrectly disabled the reflection textarea and optional
destination ratings. Completion now keeps route progression locked while these
two controls remain editable, subject to the existing busy/conflict locks. Both
continue through the unchanged saveSession queue and CAS payloads, retaining
finished=true. More-to-try is an expanded section. At desktop widths the route
result occupies the left column and reflections/optional items the right;
mobile uses the existing stacked document order.

10 editor/presentation checks and 68 real SQLite/HTTP boundary checks pass,
including editing a completed record, reopening it with the reflection and
destination score intact, and preserving its completed state. TypeScript and
walk-state regression pass. Backend and persistence queue are unchanged.
Browser control remains unavailable; live visual acceptance is still pending.

## Initial spacing patch (v72)

Baseline: deployed Sites v71, source 18914ac880270fb0e1649d5f4c40668cba316dae.

The supplied live-site screenshot shows the completed journey spending most of
the viewport on navigation spacing and an oversized arrival ornament. The
destination title appears near the bottom, with the route and reflection below.

Only the arrival/reflection state receives the new `is-reflection` class. New
styles apply above 768px: wider content, tighter navigation, a smaller ornament
and heading, shorter summary-row gaps, and a more compact reflection field.
All result rows, notes, limitations, reflection values and save controls remain.
The active walk, route preview, homepage and mobile styles are unchanged.

TypeScript, walk-state regression and whitespace checks passed. Browser control
was unavailable in this session; no desktop screenshot comparison or visual
acceptance is claimed. Production build is required by the publication workflow.
The final gallery image should be captured from the updated live reflection
page, rather than composed from this feedback screenshot.
