# The Artisign Design Workflow — Tutorial

This tutorial walks through designing a small product with Artisign the way
the tool wants to be used: design-system-first, refs everywhere, reviewed after
every step. It is the long-form companion to the compact
[Agent Guide](./agent-guide.md), which agents load on demand via the
`get_guide` tool. **The Agent Guide is normative** — where the two differ, the
Agent Guide wins; this tutorial explains and demonstrates, it does not add
rules.

Who this is for:

- **Humans** setting up Artisign for their agents and wanting to understand
  the intended workflow before writing prompts or skills.
- **Skill authors** who want to distill project-specific instructions for their
  design agents — copy freely, this document is meant to be quarried.
- **Agents** with room to spare that want the reasoning behind the rules.

Throughout we design a fictional note-taking app, *Notely*, with three screens:
a note list, a note editor, and settings.

---

## 1. Why design-system-first

Artisign stores screens as augmented HTML in plain files. Nothing stops you
from writing three screens of raw HTML with inline styles — they will render
fine. But you would be using a fraction of the tool, and the most expensive
fraction at that.

The tool's leverage lives in the design system:

- **Consistency is structural, not disciplinary.** When every button is
  `class="$btn-primary"` and every gap is `$spacing.md`, screens cannot drift
  apart. When values are inline, consistency depends on every future edit
  remembering every past decision — which no agent (or human) does reliably.
- **Change propagates.** Rebranding *Notely* from blue to green is one
  `set_tokens` call touching one file. With inline values it is a find-and-
  replace across every screen, with all the misses that implies.
- **Smaller contexts suffice.** An agent that reads a design-system summary and
  composes refs needs far fewer tokens than one that re-derives visual
  decisions per screen. This is what makes it practical to run design tasks on
  smaller, cheaper models: the system carries the design intelligence, the
  agent assembles.

The rest of this tutorial is that principle applied in order.

---

## 2. Phase 0 — Know before you design

Every session, before any write:

```text
get_project                 → screens, counts, design-system pointer (summary)
get_design_system           → all tokens, components + variants, patterns
list_comments (open)        → what the human asked for since last time
```

This trio is cheap by design (tiered reads, summaries by default) and
non-negotiable: you cannot reuse a component you have not seen, and you should
not design past an open comment that changes the brief.

Resist the urge to read every screen "for context." Screens are loaded lazily:
`get_screen` in `summary` first, `tree`/`full` plus a `fields` selection only
for the part you are about to touch. For cross-screen questions — "which
screens use `$color.accent`?" — use `find_nodes`; it exists precisely so you
never have to trawl screens manually.

---

## 3. Phase 1 — Tokens

*Notely* starts empty, so we start with tokens — not because ceremony demands
it, but because every later step references them.

A good starter set is small and role-named:

```jsonc
// set_tokens, mode: "patch"
{
  "color": {
    "bg": "#FAFAF7", "surface": "#FFFFFF", "text": "#1A1A18",
    "text-muted": "#6B6B66", "primary": "#3B6B4F", "border": "#E4E4DE",
    "danger": "#B4423A"
  },
  "spacing": { "xs": "4px", "sm": "8px", "md": "16px", "lg": "24px", "xl": "40px" },
  "radius":  { "sm": "6px", "md": "10px" },
  "type": {
    "family": "'Inter', system-ui, sans-serif",
    "size-sm": "13px", "size-md": "15px", "size-lg": "20px", "size-xl": "28px"
  },
  "shadow": { "card": "0 1px 3px rgba(26,26,24,0.08)" }
}
```

`mode` is required: `"patch"` merges into the existing tokens, `"replace"`
rewrites `tokens.json` wholesale.

Guidelines that pay off later:

- **Name by role, not appearance.** `color.primary`, not `color.green`. When
  the rebrand comes, `color.green: #B45309` is nonsense; `color.primary`
  just changes.
- **Fewer, firmer tokens.** A dozen tokens you actually use beat fifty
  speculative ones. Add tokens when a real screen needs them (see promotion,
  §6) — don't stockpile.
- **Scales, not values.** Spacing as a scale (`xs`–`xl`) keeps rhythm
  consistent; ad-hoc `18px` values are how layouts fall out of step.

---

## 4. Phase 2 — Base components

Next, the pieces every screen will need. For *Notely*: a button, a list row, a
card. Components are written with `write_html` using `kind: "component"` — a
default-variant root plus optional `<template data-variant>` siblings:

```html
<!-- write_html kind:"component", mode:"create", screen: "btn-primary" -->
<button style="background: $color.primary; color: $color.surface;
               padding: $spacing.sm $spacing.md; border-radius: $radius.sm;
               font: 500 $type.size-md $type.family; border: none">
  <span data-slot="label">Label</span>
</button>
<template data-variant="hover">
  <button style="background: mix($color.primary, $color.text, 0.15);
                 color: $color.surface;
                 padding: $spacing.sm $spacing.md; border-radius: $radius.sm;
                 font: 500 $type.size-md $type.family; border: none">
    <span data-slot="label">Label</span>
  </button>
</template>
<template data-variant="disabled">
  <button style="background: alpha($color.primary, 0.4);
                 color: $color.surface;
                 padding: $spacing.sm $spacing.md; border-radius: $radius.sm;
                 font: 500 $type.size-md $type.family; border: none">
    <span data-slot="label">Label</span>
  </button>
</template>
```

**Each variant is standalone, not a patch on the default.** The renderer picks
exactly one variant and renders only that markup — it does not merge the
default underneath. A variant that declares only the one property it changes
renders as a button without padding, font or radius, and a variant that omits
`data-slot="label"` swallows the instance's content, because there is no slot
left to put it in. Repeat the full markup in every variant and change what
differs. The component name is the `screen` parameter of `write_html`; there
is no `name` parameter.

Note what just happened: **the component itself is made of token refs.** The
system is self-referential all the way down — restyle the tokens and the
components follow, restyle the components and the screens follow.

Two rules of thumb:

- **Variants over siblings.** A hover state, a disabled state, a compact size —
  these are `data-variant`s of one component, not `btn-primary-2`. Sibling
  near-duplicates are the design-system equivalent of copy-paste code.
- **Slots for content.** `data-slot="label"` marks where instances inject
  content. Everything else in the component is structure the instance should
  not repeat.

`get_screenshot` renders screens, not component definitions — so you review a
component through its first instance: place it on the screen that needs it,
screenshot that screen (or clip to the instance node) and look. Red outlines
mean an unresolved ref — a typo'd token name, usually. Fix before moving on.

---

## 5. Phase 3 — Screens as assemblies

Now screens, and here the payoff shows. The note list:

```html
<!-- write_html screen: notes -->
<main id="notes-root" style="background: $color.bg; min-height: 100vh;
                             padding: $spacing.lg">
  <header id="notes-header" style="display: flex; justify-content: space-between;
                                   margin-bottom: $spacing.lg">
    <h1 style="font: 600 $type.size-xl $type.family; color: $color.text">Notes</h1>
    <button id="btn-new-note" class="$btn-primary" data-flow-target="editor">
      <span data-slot="label">New note</span>
    </button>
  </header>
  <ul id="notes-list" style="display: flex; flex-direction: column;
                             gap: $spacing.sm">
    <li id="note-row-1" class="$note-row" data-flow-target="editor"></li>
    <li id="note-row-2" class="$note-row" data-variant="pinned"></li>
  </ul>
</main>
```

Read that screen again: **there is not a single raw color or size in it** apart
from layout mechanics (`flex`, `100vh`). Everything visual is a ref. That is
what "screens are assemblies" means, and it is the state every screen should
end in.

Also note the two `data-flow-target`s. Flows are wired *while designing*, not
documented afterwards — the "New note" button navigating to the editor is part
of the design, stored as data, visible in the preview's flow mode, and readable
by any agent via `get_screen`. Later edits to routing go through `set_flow`
without touching HTML.

After the write: `get_screenshot notes`. For a follow-up tweak to one element,
screenshot just that node (`node` parameter) — clipped captures cost a fraction
of full-screen vision tokens. And for measurable questions — "is the header
gap really 24px?" — skip vision entirely and use `inspect_node`, which returns
computed geometry and styles as text.

Then iterate with the cheapest write that does the job:

| Change | Tool |
|---|---|
| Swap which token/component/variant a node points at | `update_refs` (cheapest — no HTML parse) |
| Local structural edit (add a row, change a label) | `patch_html` |
| New screen or full structural overhaul | `write_html` |

One write, one look. Chaining five writes before the first screenshot is how
small errors compound into a broken screen you then debug expensively.

---

## 6. Exploration and promotion — how new design enters the system

Design-system-first does not mean no exploration. For a genuinely new direction
— say *Notely* gets a visual redesign concept — sketching directly in a screen
with inline values is allowed and often the honest way to find a design.

The contract is what happens *next*:

1. **Explore in one screen.** Inline values, fast iteration, screenshot loop.
   This screen is a draft; treat it that way.
2. **Promote what repeats.** The moment a value or element pattern occurs a
   second time, lift it: `promote_to_system` creates the token / component /
   pattern. For tokens and components it *also rewrites the existing
   occurrences to refs*; a promoted pattern only gets its file, since patterns
   have no instance mechanism. The second occurrence is the trigger — do not
   wait for the third.
3. **Sweep the draft.** After promoting, the exploration screen itself must end
   ref-clean: remaining inline values are either promoted or replaced via
   `update_refs` / `patch_html`.
4. **From screen two on: refs only.** An inline value on the second screen of a
   direction is a bug, not a style choice. If the system lacks what you need,
   that is a system gap — add the token or component first, then reference it.

Promotion is also how you name well: at promotion time you know the *role* the
value plays ("this orange is our accent"), which you did not know when you
first typed the hex. Name it for the role.

**When the question is which direction, not just one draft.** The single-draft
flow above assumes you already know roughly where you're headed. When you
genuinely don't — several interaction models for one screen, or a handful of
early directions before any design system exists — reach for a mockup
instead of a screen. `write_mockup` writes each option as its own variant
(raw HTML, no refs, no drift warnings; a mockup lives entirely outside the
ref model), `get_screenshot {mockup, variant}` reviews each one, and
`write_mockup mode: "replace"` revises a variant the same way you'd iterate
on a draft screen. Once a direction wins, `promote_mockup` copies that one
variant into a real screen via the normal `write_html` path, leaving the
mockup itself on disk as exploration history (`delete_entity` it once you no
longer need it) — from there, steps 2–4 above apply exactly as they would to
any other screen: the promoted screen is still a draft until its repeated
values are promoted and swept.

---

## 7. Comments, metadata, and handoff

Artisign is a two-party loop: agents design, the human reviews in the
browser and comments on specific nodes.

- **Start of session:** `list_comments` (`status: "open"`). Comments anchor to
  node ids — which is why ids must stay stable across writes. Regenerating ids
  orphans the conversation attached to them.
- **Close the loop:** address the comment, `reply_comment` with what you did,
  resolve it. An addressed-but-unanswered comment looks identical to an
  ignored one from the human's side.

The second audience is other agents — usually a coding agent implementing the
design later. Your handoff channel is `set_meta`:

| Target | Field | What to write |
|---|---|---|
| component / pattern | `usage` | When to use it, when not to, slot expectations ("Primary action, max one per screen") |
| design system | `idea`, `decisions` | The design direction and settled choices, so they are not relitigated |
| screen | `notes`, `tags` | What a screenshot cannot carry: states, empty/error cases, content rules |
| mockup | `tags`, `title`, `description` | Makes an exploration findable via `get_project {tags: [...]}` before it is promoted |

Write metadata **when the decision is fresh**. A cleanup pass at the end
reliably produces vague metadata, because the reasoning is gone.

---

## 8. Anti-patterns, and why each one bites

| Anti-pattern | Why it hurts |
|---|---|
| Inline value duplicating an existing token | Silent drift: the token changes, this spot doesn't. This is the single most common failure mode. |
| New component that is an existing one with a tweak | Doubles maintenance, splits future edits, bloats `get_design_system` for every later session. Make it a variant. |
| Repeated structure across screens, never promoted | Consistency now depends on memory. The third copy will differ. |
| Writes without screenshots between them | Errors compound; you debug a pile instead of a step. |
| `get_screenshot` for geometry questions | Wildly more expensive than `inspect_node`, and less precise. |
| Reading full screens to search for something | `find_nodes` does it in one call. Full reads are the biggest avoidable token sink. |
| Regenerated / renamed node ids | Orphans comments and breaks flow edges. Ids are the anchor everything else hangs on. |
| Interactive element without `data-flow-target` | The design is unfinished: nobody can say where the click goes, and flow mode shows a dead end. |
| Metadata as an afterthought (or absent) | The next agent re-derives — or worse, contradicts — decisions you already made. |

---

## 9. Building skills from this workflow

If you run your own agents against Artisign, the recommended split:

- **Let the tool teach mechanics.** The MCP server instructions and the
  `get_guide` Agent Guide already cover grammar, tools, and workflow. Do not
  duplicate them into your skill — duplicated instructions drift.
- **Put project specifics in your skill.** Your brand constraints, your
  approval process, which screens exist and why, naming conventions beyond the
  defaults. That is what the tool cannot know.
- **Anchor the skill to the workflow phases.** "Session start: get_project,
  get_design_system, list_comments. Then …" — agents follow phase-shaped
  instructions much more reliably than rule-shaped ones.
- **For smaller models, lean harder on examples.** Copy the worked example from
  the Agent Guide and swap in your actual tokens and components. A concrete
  ref-clean screen in the prompt outperforms three paragraphs of rules.

---

## 10. The short version

1. Read the system before designing (`get_project`, `get_design_system`,
   `list_comments`).
2. Empty project: tokens → components → screens. Exploration inline is fine
   for the first screen of a direction; promote and sweep before screen two.
3. Screens end ref-clean: every visual value a `$token`, every repeated element
   a `$component`, every state a `data-variant`.
4. One write, one look (`get_screenshot`; `inspect_node` for geometry).
5. Second occurrence → `promote_to_system`. Name by role.
6. Wire flows while designing; keep node ids stable.
7. Answer comments; write `set_meta` while decisions are fresh.
8. Restyle via `set_tokens`, retarget via `update_refs` — never by walking
   screens.
