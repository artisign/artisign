# Use-Case-Darstellung artisign: Varianten und Empfehlung

Stand: 26.11.2026, ca. 15:50 MEZ. UX Design. Keine Abnahme, keine Selbstprüfung; UX Review schaltet Assi bei Bedarf ein.
Inhalt aller Mockups: echter Use Case `present-ticket-on-board` und weitere echte Fälle aus `design/usecases/` im Repo (Branch design/CHR-1257-ui-refresh). Screen-Bilder sind echte Renderings der gemappten Screens (`/api/render/<screen>` der 2.3.0-Instanz), keine generierten Bilder. Look: rund und ruhig wie die CHR-1257-Richtung „Dock“.

Mockups (1440×900 und @2x):

## V1 Brief + Inspector (Master-Detail, drei Spalten)
- mockups/v1-brief-inspector.png
- mockups/v1-brief-inspector@2x.png

Idee: Liste links, in der Mitte ein „Brief“ mit vier Kacheln (Who, When, Goal, Outcome) und der nummerierten Flow-Liste; World, Inputs/Outputs und Varianten sind eingeklappt, der gewählte Schritt öffnet rechts einen Inspector mit Screen-Bild und Datenzustand. Vorteil: vertraut wie Linear/Jira, alles ohne Scrollen sichtbar; Nachteil: drei Spalten machen den Screen klein (rund 370 px), und die Screens der anderen Schritte sieht man nur als Textchip.

## V2 Storyboard (Flow als Bildergeschichte) – Empfehlung
- mockups/v2-storyboard.png
- mockups/v2-storyboard@2x.png
- Detail-Zustand: mockups/v2-storyboard-detail.png
- Detail-Zustand: mockups/v2-storyboard-detail@2x.png

Idee: Oben ein Band mit Who, When, Goal und World, darunter der Flow als Reihe von Schritt-Karten mit dem echten Screen-Bild, Branches als eigene Lane darunter und das Outcome als Ziel am Ende; ein Klick auf einen Schritt öffnet rechts einen Drawer mit Screen groß, Datenzustand, Inputs/Outputs und Vor/Zurück. Vorteil: Use Case und Screens in einem Blick, so wie artisign gedacht ist (Spec → Screens), und passt zum Dock aus CHR-1257; Nachteil: Flows mit mehr als 4–5 Schritten (z. B. add-branch mit 7) brauchen Zoom, horizontales Scrollen oder eine kompakte Kartengröße.

## V3 Karten + Side Peek (Sammlung zuerst)
- mockups/v3-cards-peek.png
- mockups/v3-cards-peek@2x.png

Idee: Use Cases als Karten pro Gruppe mit Actors, Goal, Mini-Screens und Zählern; ein Klick öffnet rechts einen Side Peek wie in Notion mit Who/When/Goal/Outcome, ausgeklapptem Flow mit kleinen Screen-Bildern und eingeklappten Abschnitten. Vorteil: bester Überblick über viele Fälle und schneller Wechsel ohne Kontextverlust; Nachteil: Karten skalieren schlecht bei großen Projekten (Constellation „Large“: tausende Use Cases), und der Peek ist für Branches und Daten eng.

## Empfehlung: V2 Storyboard
Begründung: Nur V2 zeigt beim Öffnen alles, was der Auftrag verlangt (Actor, Trigger, Goal, Main Flow, Branch, Outcome, Status, verlinkte Screens), ohne Scrollen und mit den Screens als Bild statt als Textchip. Details stehen im Drawer bereit, die Fläche bleibt ruhig. Das ist der Kern von artisign („Review the plan“): Man sieht, was der Agent bauen will, Schritt für Schritt am Screen. Heute braucht man dafür zwei getrennte Modi (Detail und „Show on screens“), V2 führt sie zusammen.

Zum Mitnehmen aus den anderen Varianten:
- Aus V1: die Liste als Panel hinter dem Dock-Icon „Use cases“ (Suche, Filter, Gruppen) statt einer festen Spalte.
- Aus V3: die Kartenansicht als zweite Listen-Darstellung (Umschalter Liste/Karten) für kleine Projekte.

Offene Punkte für den Bau (Entscheidung Christian / Builder-Brief durch Assi):
1. Verhalten bei langen Flows: Kartenbreite automatisch verkleinern ab 5 Schritten oder „Fit“ als Standard.
2. Schritte ohne Screen (wie Schritt 1): Platzhalter mit Datenänderung, wie im Mockup, oder schmalere Karte.
3. Varianten: Umschalter im Band (heute „Base“-Pill); ein Wechsel markiert geänderte/neue Schritte auf den Karten.
4. Element-Mapping (`target.node`): Marker auf dem Screen-Bild der Karte, wie heute in „Show on screens“.
