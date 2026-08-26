/**
 * Compact augmentation-grammar cheat sheet surfaced to the client as the
 * server's `instructions` — a design agent's first look at how to
 * write screens, before it ever calls a tool. Kept to a single copy: tool
 * descriptions point back here instead of repeating the grammar.
 */
export const INSTRUCTIONS = `Artisign — augmentation grammar for screen HTML (html_aug).

WORKFLOW: tokens -> components -> screens; inline values only while exploring
screen one of a direction, promoted before screen two; second occurrence of a
value/pattern gets promoted, named by role. One write, one look
(get_screenshot/inspect_node).

COMPONENT INSTANCE — two equivalent syntaxes:
  class="$btn-primary"            (token-style ref)
  data-component="btn-primary"    (explicit, wins if both present)
A child with data-slot="label" fills that slot; other children fill
positional slots (slot-0, slot-1, ...) in document order.
In a definition, never style the data-slot element — style a wrapper.

TOKEN REF — inside a style VALUE, mixable with literal text, multiple per value:
  style="border: 1px solid $color.border; padding: $spacing.sm $spacing.lg"
Flat names ($primary) resolve if unambiguous. Modifier functions wrap a
ref: alpha($color.primary, 0.1), oklab($color.primary), mix($a, $b, 0.5).

VARIANT:
  data-variant="hover"            selects a component variant

FLOWS:
  data-flow-target="checkout"     screen id, or "checkout.node-id" for a node
  data-flow-trigger="tap"         optional; tap (default) | hover | longpress
                                   | swipe-left | swipe-right

NODE IDS:
  id="btn-login"  stable, human-chosen; generated if omitted — keep it
  stable across writes (patches and comments address nodes by id).

EXAMPLE:
  <section id="hero" style="padding: $spacing.lg">
    <button id="btn-login" class="$btn-primary" data-variant="hover"
            data-flow-target="dashboard">
      <span data-slot="label">Log in</span>
    </button>
  </section>

REVIEW LOOP: after every write_html / patch_html, call get_screenshot
{screen} and check the image before the next edit — red outlines mark an
unresolved token, component, or variant ref.

METADATA: set_meta writes notes/tags (target: {kind:"screen", screen}),
tags/title/description (target: {kind:"mockup", mockup}), idea/decisions
(target: {kind:"design_system"}), or usage guidance on a component/pattern
(target: {kind:"component"|"pattern", name}, field: usage) — the handoff
contract to coding agents; find screens or mockups by tag via get_project
{tags: [...]}.

LIFECYCLE: write_html kind:"component"|"pattern" writes a definition
(default variant + <template data-variant> siblings). delete_entity
{kind, name} deletes a screen/component/pattern/mockup; refused if
referenced (screen/component only).

MOCKUPS: for several options of one screen, or early directions before a
design system exists — raw HTML, outside the ref model, no drift warnings.
write_mockup {mockup, variant, mode, html} per variant -> get_screenshot
{mockup, variant} in a loop while iterating -> promote_mockup {mockup,
variant, screen} copies the chosen one into a real screen (the mockup
stays as exploration history; delete_entity it when done). Refs/drift
discipline applies to that screen from then on, same as any other. Tag a
mockup via set_meta (target: {kind:"mockup", mockup}) to make it findable
in get_project {tags: [...]}, same as a screen.

RENDER ENVIRONMENT (guaranteed, no re-declare needed): border-box sizing,
zero body margin — declared widths/heights render exactly as given. Fonts
named in tokens.json typography values are auto-loaded. Icons are Material
Symbols ligatures: <span class="icon">close</span> — never a Unicode glyph.`;
