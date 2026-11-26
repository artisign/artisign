# Ist-Stand Use-Case-Ansicht (artisign 2.3.0)

Aufgenommen am 26.11.2026, ca. 15:35 MEZ. Build: artisign 2.3.0 (lokales dist, nur ausgeführt, nichts geändert). Aufgenommen auf einer eigenen Instanz mit eigenem ARTISIGN_HOME und einer Kopie von design/ aus Branch design/CHR-1257-ui-refresh (532728c). Die laufende Review-Instanz blieb unberührt. Die Aufnahme-Instanz wurde danach gestoppt. Beispiel: present-ticket-on-board (echter Use Case aus dem Repo).

Screenshots (1440×900, @2x):
- ist-01-use-case-detail-oben@2x.png
- ist-02-use-case-detail-scroll-800@2x.png
- ist-03-show-on-screens@2x.png

## Was die Ansicht kann (UI + docs/agent-guide.md, src/preview/usecases-*.js)

- Tab „Use Cases (Beta)“ mit Unter-Tabs Use cases, Personas, World, Data objects, „+“.
- Liste links: Suche (Titel, Trigger, Schritte), Filter Persona, Constellation, Status, Tag, Screen, „Has variants“, Sortierung, Gruppierung nach `group`-Pfad mit Zählern. Eintrag zeigt Status und Branch-/Constellation-Zähler.
- Detail: Gruppe, Titel, Status (draft/ready), Tags (Ticket-Links), ID; „Show on screens“, „Edit“, Menü. Varianten-Umschalter (Base, + Variant) und Abdeckungslücke („7 trait values not covered“).
- Personas mit Traits, Trigger (Actor, via), Goal, Outcome.
- World: Constellation-Karte mit Beziehungen und Mitgliedern, „Open in World“.
- Flow: Schritte mit Actor, via, Aktion, Mapping (Screen/Element oder „Not mapped“), Before/After-Daten; Branches als eingerückte Lane mit When-Bedingung, Schritten und Ende/Rejoin.
- Inputs and outputs: Tabellen je Datenobjekt mit Feld, Typ, Beispielwert.
- „Show on screens“: eigener Modus, links Flow-Liste, rechts Screen-Thumbnails je gemapptem Schritt mit Markern (Main step, Branch step, Element, Whole screen, Stale).
- Bearbeiten über Dialoge, Umsortieren per Drag, Varianten bearbeiten, Mapping (laut Dateien usecases-dialog, -reorder, -variant-edit, -mapping).

Datenmodell (agent-guide.md, „Use cases“): title, group, tags, status, personas, constellations, trigger (Text oder {text, actor, via, state, at}), goal, outcome, inputs/outputs ({object, example, source/target}), steps ({id, actor, action, target {screen, node}, data before/after, via}), branches ({id, title, from, when, steps, rejoin, outcome}), variants ({id, title, when, Overrides, step ops}), state.

## Was am Überblick hakt (eigene Beobachtung in den Screenshots)

1. Auf 1440×900 beginnt der Flow erst bei etwa 770 px. Ohne Scrollen sieht man Personas, Trigger, Goal, Outcome und die World, aber keinen Schritt.
2. Gemappte Screens stehen nur als Textchip (`board-view-presented`). Bilder gibt es erst im getrennten Modus „Show on screens“.
3. Die World-Karte nimmt oben viel Platz, obwohl sie für den Sofortüberblick selten zählt.
4. Persona-Zeilen wiederholen Traits als langen Text („Agent · Design agent · Actor type Agent · Experience Regular“).
5. Inputs/Outputs als volle Tabellen mit vielen leeren Beispielwerten („—“) verlängern die Seite.
6. Alles liegt in einer Spalte von etwa 600 px; links und rechts bleibt Fläche ungenutzt.
