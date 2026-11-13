---
name: artisign
description: How to design well with the artisign MCP tools — design system first, tag every screen with its ticket and its domain, model states, overlays and steps as screen variants, look at every write, and leave handoff metadata for coding agents. Use whenever you create, change, review or hand off screens, components, tokens or mockups in an artisign project (any mcp__artisign__* tool).
---

# Designing with artisign

artisign stores a design as files: tokens, components and patterns in the design system, screens as HTML that references them. Your job is to keep screens consistent and findable. These rules are not optional; the details behind them are in the full guide (`get_guide`).

## 1. Start every session the same way

1. `list_projects`, then pass `project` (name or absolute root) to every call.
2. `get_project` (summary). Before you touch screens, `get_project {view: "tree"}` so you know the existing screens, their **tags** and their **variants**.
3. `get_design_system {view: "tree"}` — every token, component and pattern. You cannot reuse what you have not read.
4. Working on a ticket? `get_project {tags: ["<ticket-tag>"]}` and read its `tag_notes` first: that is the feature spec.
5. Read the full guide once per project or when unsure: `get_guide`.

## 2. Tag every screen and mockup you create or change

Tags are how humans and coding agents find your work. A screen without tags is lost work.

- **Ticket tag** — when you work from a ticket or issue, its id in **lowercase**: `chr-585`, `proj-12`, `gh-301`. Every screen and mockup you create or change for it gets that tag. No ticket named? Ask once per task whether there is one; if there is none, the domain tag is enough. Never invent a ticket id.
- **Domain tag** — the product area, lowercase, kebab-case: `onboarding`, `checkout`, `settings`, `dashboard`. Reuse the domain tags the project already has (see step 1.2); add a new one only for a genuinely new area.
- Optional **kind tags** only where the project already uses them (`dialog`, `empty-state`).
- **Tags are cumulative.** `set_meta`'s `tags` replaces the whole list: read the current tags (every `get_screen` response carries them), append, then write. Never drop someone else's tag.
- **Write the spec once, on the tag:** `set_meta {target: {kind: "tag", tag: "<ticket-tag>"}, notes}` — goal, screens involved, decisions, open points. Screen-specific detail goes into that screen's own `notes`.

## 3. Same page in another condition → a variant, not a new screen

A variant is a normal screen that names its parent. Set it right after the first write:

`set_meta {target: {kind: "screen", screen: "dashboard-empty"}, variant_of: "dashboard", variant_kind: "state"}`

| `variant_kind` | Use for |
|---|---|
| `state` | the same view with other data or status: empty, loading, error, filled, dark theme |
| `overlay` | something layered over the parent: sheet, modal, popover, menu, toast |
| `step` | a stage in a sequence that starts at the parent: wizard step, onboarding page, confirmation that replaces a sheet |

- A different destination is a new main screen; the same page in another condition is a variant. When a reviewer would look for it next to another screen, it is a variant.
- A sheet stacked on another sheet is an `overlay` of that sheet, not of the screen below.
- Name variants `<parent>-<condition>` (`dashboard-empty`), but the name never replaces `variant_of` — the relation is data, not a naming convention or a sentence in `notes`.
- Give structural nodes stable, descriptive `id`s (`card-list`, `empty-state`) that stay the same across the parent and its variants; the compare view matches nodes by id.
- A new style of a component (hover, disabled, selected) is a **component variant** (`<template data-variant>`), not a screen variant and not a new component.

## 4. Design system first

- Values come from tokens (`$color.primary`, `$spacing.md`), elements from components (`class="$btn-primary"`). Inline values only while exploring the first screen of a new direction.
- The second time a value or structure appears, promote it to a token, component or pattern, named by role (`color.surface`, not `color.gray-100`).
- A drift warning means you inlined a value a token already has: use the token.
- Never edit the project's files directly or by script — change the design only through the artisign tools.

## 5. One write, one look

After every `write_html`, `patch_html`, `write_mockup` or definition change, call `get_screenshot` and check the image before the next edit. Red outlines are unresolved refs: fix them before you move on.

## 6. Leave handoff metadata

`set_meta` is the contract with the coding agent that builds your design:

- screens: `notes` for states, edge cases and content rules a screenshot cannot show; tags and variants as above.
- components and patterns: `usage` — when to use, when not, what goes in each slot.
- design system: `idea` and `decisions`, so the next agent does not relitigate them.
- mockups: `tags`, `title`, `description` — explorations must be findable too.
- interactive elements: `data-flow-target` to their destination screen.

## Done checklist

Before you report a screen as done, every answer is yes:

- [ ] It carries a domain tag and, when there is a ticket, the ticket tag (both lowercase); no existing tag was dropped.
- [ ] When there is a ticket, its tag has `notes` with the cross-screen spec.
- [ ] Every state, overlay and step of a page is a variant with `variant_of` + `variant_kind`.
- [ ] No inline value duplicates a token; repeated structure is a component or pattern.
- [ ] The last screenshot shows no red outlines.
- [ ] Every interactive element has a flow target.
- [ ] New components and patterns have `usage`.
