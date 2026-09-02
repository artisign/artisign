# Designing with Artisign — Agent Guide

This guide is the design methodology for agents working through the Artisign
MCP tools. The server instructions cover tool *mechanics* (augmentation grammar,
tool shapes); this guide covers *how to design well*. Load it when you need the
methodology.

## Core principle

**The design system is the product. Screens are assemblies of refs.**

A screen that repeats raw hex colors and pixel values across elements is
unfinished work: it cannot be re-themed, it drifts from its sibling screens, and
every future edit costs more. Your success is measured by consistency across
screens, and consistency comes from refs (`$token`, `$component`), not from
discipline in copying values.

## Session start

1. `get_project` (default `summary` view) — screens, counts, design-system pointer.
2. `get_design_system` — know every token, component, and pattern **before**
   designing anything. You cannot reuse what you have not read.

Do not read full screens upfront. Load detail lazily with tiered reads.

## Empty project: system first, exploration allowed

On a fresh project the order is: **tokens → base components → screens.**

- Define tokens first: color palette, type scale, spacing scale, radius, shadow
  (`set_tokens`). A dozen well-named tokens beat fifty speculative ones.
- Build base components next (`write_html` with `kind: "component"`, the name
  goes in `screen`): button, input, card — the pieces every screen needs.
  Each `<template data-variant>` holds the **complete** markup of that variant,
  slots included — variants are not merged onto the default.
  **Never style a `data-slot` element itself.** An instance replaces that
  element whole, so its `style`/`class` — or a component ref on it — is
  discarded. Style a wrapper around the slot instead; `write_html` and
  `promote_to_system` warn when a definition styles a slot anyway. One catch: a wrapper sitting *directly
  under the definition root* is itself an implicit positional slot, so it is
  replaced too whenever an instance fills slots by position — including when
  an instance names a slot the definition does not declare, since that
  leftover override is then matched positionally. Root-level wrappers are
  safe only while every instance child names a slot the definition has.
  The slot's **tag** goes the same way as its styling: `<h3 data-slot>`
  filled by a `<span>` renders as a `<span>`. Nothing warns about that —
  put semantics on the wrapper too.
- Only then design screens, composed of refs. An instance may carry its own
  `style`, extra classes and plain attributes (`href`, `aria-*`, a flow
  target) — they land on the expanded root, the instance winning over the
  definition on a conflict, `style` and `class` accumulating. Its children
  fill the slots, including with other component instances.

**Exploration mode:** for the *first* screen of a new direction you may sketch
with inline values to find the design. That is a draft, not a deliverable.
Before moving on you MUST:

1. `promote_to_system` every repeated color, spacing, or element pattern.
2. Re-check the screen: every promotable value replaced by a ref
   (`update_refs` / `patch_html`).
3. A second screen with inline values is a bug — from screen two onward,
   refs only.

## Exploring options with mockups

Exploration mode above covers *one* draft screen you promote before moving
on. Sometimes the question is genuinely open — several interaction models
for the same screen, or a handful of early design directions before any
design system exists at all. That is what mockups are for: `write_mockup`
one variant per option (`{mockup, variant, mode: "create", html}`, raw HTML,
no refs, no drift warnings — write whatever markup makes the option
concrete), then `get_screenshot {mockup, variant}` to look at each one.
Iterate with `write_mockup mode: "replace"` the same way you'd revise a
screen. Mockups sit outside the design system on purpose — they never touch
`screens/`, never resolve a `$ref`, and are never subject to promote
discipline while they stay mockups.

Once a direction wins, `promote_mockup {mockup, variant, screen}` copies that
one variant into a real screen via the normal `write_html` path — the mockup
itself stays on disk as exploration history; delete it with `delete_entity`
once you no longer need it. From that point on the screen is a screen:
refs/promote discipline applies exactly as in exploration mode above — a
mockup variant is a draft too, not a deliverable, and promoting it doesn't
grandfather its inline values in.

## Existing project: refs only

When a design system already exists:

- Reuse before inventing. Check `get_design_system` for a matching token or
  component. Near-match beats new: prefer adding a `data-variant` to an
  existing component over creating a sibling component.
- A value the system lacks is a *system gap*: add a token (`set_tokens`) or
  component, then reference it. Never write the raw value inline.
- Global restyling goes through `set_tokens` — change the token, every screen,
  component, and pattern that references it follows. Never walk screens
  rewriting values.

## The review loop

After **every** `write_html` / `patch_html`:

1. `get_screenshot` for the screen (or clipped to the changed `node` — much
   cheaper) and look at the image.
2. Red outlines mark unresolved token/component/variant refs. Fix before the
   next edit.
3. For geometry and computed-value questions ("is this 44px tall?", "what color
   resolved?") use `inspect_node` — text is far cheaper than vision.

Never chain multiple writes without looking. One write, one look.

Both tools need Playwright, which is optional and not bundled. It has to resolve
from where Artisign itself is installed — Playwright added to a different
project tree is not seen — unless `ARTISIGN_PLAYWRIGHT_DIR` names a directory
that holds it. With a local install of Artisign, run in that directory:

`npm install --no-save playwright && npx playwright install chromium`

Everything else in this guide works without it, so treat a
`Playwright is not installed` (or `installed but unusable`) error as a setup
gap to report — the message carries the fix — not as a bug in your design work.

### Reviewing a component before a screen uses it

`get_screenshot` on a component definition renders it in isolation. That is the
right view for the definition itself, but it cannot answer whether the component
behaves once it is filled and placed — an empty slot's layout, a copy affordance
against a full-length line, a `wide` variant breaking out of its content column.

Do not wait for the first real screen to find out. Write a scratch screen that
instantiates the component with real slot content under a real width, screenshot
that, and `delete_entity` it when the question is answered. It costs two calls
and keeps a class of defect out of the next ticket.

Keep it disposable: a scratch screen that survives the review becomes a screen
someone has to maintain.

## Promote discipline

`promote_to_system` is the ratchet that turns exploration into system:

- **Second occurrence rule:** the moment a value or element pattern appears a
  second time, promote it. Do not wait for a third.
- `kind: "token"` rewrites every other structurally identical occurrence
  project-wide to a ref — screens, components, and patterns alike — so you
  get consistency retroactively. `kind: "component"` rewrites every
  structurally identical occurrence across screens, but never inside another
  component or pattern definition — a call targeting one screen node must not
  have the side effect of rewriting curated design-system source files.
  `kind: "pattern"` only creates the pattern file: patterns have no instance
  mechanism, so the source markup stays as it is.
- Name promoted entities by role, not appearance: `color.accent`, not
  `color.orange`; `btn-primary`, not `btn-rounded-blue`.

## Token efficiency

These tools are built for small contexts — use the levers:

- Reads default to `summary`; request `tree`/`full` and `fields` only for what
  you will actually use.
- `find_nodes` answers cross-screen and design-system questions ("every
  button using `$color.primary`", which may live only in a component
  definition) in one call — never read all screens to search. A match with
  `source: "component"|"pattern"` carries `id_stability: "explicit"|"derived"`
  in place of a screen match's (always-stable) node ref: definition node refs
  are addressable — `get_node`, `update_refs`, and `patch_html` all accept
  `component:<name>#<variant>.<node-id>` / `pattern:<name>.<node-id>` — but
  only reliably stable across writes when the node carries an explicit `id`.
  A `"derived"` id is allocator-generated and only guaranteed to resolve to
  the same element for the one call you got it from — including the call
  right after your own edit. Add an explicit `id` to any definition node you
  intend to address again; a write that touches one without an explicit id
  returns a `missing_id` warning saying so. `reply_comment` stays
  screen-only — comments anchor to what the browser renders, not to a
  definition.
- Cheapest write wins: `update_refs` (no HTML parse) < `patch_html` <
  `write_html`. Full rewrites are for new screens or structural overhauls —
  the same division applies to component/pattern definitions.
- Keep `response_mode: "summary"` on writes; ask for `diff` only when you need
  to verify a tricky change. `patch_html` against a `component:`/`pattern:`
  ref only supports `"summary"` — `"diff"`/`"full"` need a canonical document
  a definition doesn't have, and are rejected rather than returning a diff
  that can't actually reflect what changed.
- Screenshot the changed node, not the whole screen, when reviewing a local edit.

## Flows

Click routes are data, not annotations. Wire navigation with
`data-flow-target` (plus `data-flow-trigger` when not `tap`) as you design, or
edit edges later with `set_flow`. A screen nobody can reach, or a CTA that goes
nowhere, is an unfinished design.

## Comments

The human reviews in the browser and comments on nodes. Each design session:
`list_comments` (`status: "open"`) for open comments, address them, answer with
`reply_comment` and resolve when done. Keep node `id`s stable across writes —
comments and flows anchor to them.

## Handoff

`set_meta` is your contract with coding agents:

- On each **component/pattern**: `usage` — when to use it, when not, slot
  expectations.
- On the **design system**: `idea` and `decisions` — the direction and the
  choices already made, so the next agent does not relitigate them.
- On **screens**: `notes`/`tags` for anything a screenshot cannot carry
  (states, edge cases, content rules).
- On **mockups**: `tags`/`title`/`description` so an exploration is findable
  via `get_project {tags: [...]}` before it is promoted.

Write metadata when the decision is fresh, not as a cleanup pass.

## Anti-pattern checklist

Before calling a screen done, verify none of these apply:

- [ ] Inline hex/px values that duplicate or near-duplicate an existing token
- [ ] A new component that is an existing component with one style tweak
      (should be a variant)
- [ ] Repeated element structure across screens that is not a component/pattern
- [ ] Unresolved refs (red outlines in the screenshot)
- [ ] Interactive elements without a flow target
- [ ] Renamed or regenerated node ids on nodes that carry comments or flows
- [ ] Components without `usage` metadata

## Worked example: login screen in a fresh project

```text
1. set_tokens          → mode: "patch",
                         color.{bg,surface,text,primary,border},
                         spacing.{xs,sm,md,lg}, radius.md, type scale
2. write_html kind:"component" mode:"create" btn-primary
                       → default + <template data-variant="hover">
3. write_html kind:"component" mode:"create" input-field
4. write_html mode:"create" screen "login":
     <main id="login-root" style="background: $color.bg; padding: $spacing.lg">
       <form id="login-form" style="display: flex; flex-direction: column;
             gap: $spacing.md; background: $color.surface;
             padding: $spacing.lg; border-radius: $radius.md">
         <input id="input-email" class="$input-field">
         <input id="input-password" class="$input-field">
         <button id="btn-login" class="$btn-primary"
                 data-flow-target="dashboard">
           <span data-slot="label">Log in</span>
         </button>
       </form>
     </main>
5. get_screenshot login → check render, fix red outlines
6. set_meta component btn-primary usage:
     "Primary action, max one per screen. Use btn-secondary elsewhere."
7. list_comments → address human feedback, reply_comment, iterate
```

Every value on the screen is a ref. Restyling the whole product later is one
`set_tokens` call.
