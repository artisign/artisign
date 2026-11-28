# Recherche: Wie ähnliche Produkte Use Cases, Specs und User Stories darstellen

Stand: 26.11.2026, ca. 15:45 MEZ. Alle Links am 26.11.2026 per curl geprüft (HTTP 200, Seiteninhalt passt zum Stichwort). 404er: keine.

| Produkt / Quelle | Muster | Link |
|---|---|---|
| Linear – Peek | Leertaste auf einem Listeneintrag öffnet eine Schnellvorschau, die Liste bleibt stehen (Quick Look) | https://linear.app/changelog/2019-09-23-improved-peek |
| Linear – Custom Views | Rechte Sidebar mit Überblick und Filtern je View; Peek als Standard in Listen und Boards | https://linear.app/docs/custom-views |
| Jira – Board/Backlog | Karte anklicken öffnet die Details in einer Sidebar rechts statt im Dialog (Master-Detail) | https://support.atlassian.com/jira-software-cloud/docs/customize-your-view-of-the-board-and-backlog/ |
| Jira – Active Sprint | Work-Item-Details neben dem Board ansehen und bearbeiten | https://support.atlassian.com/jira-software-cloud/docs/view-and-edit-issue-details-in-an-active-sprint/ |
| Notion – Datenbank-Views | „Open pages in“: Side peek (Liste bleibt links bedienbar), Center peek (Modal) oder Full page | https://www.notion.com/help/views-filters-and-sorts |
| Productboard – Feature-Details | Klick auf ein Feature öffnet eine Details-Sidebar mit Tabs (Detail, Insights, Health, Portal) | https://support.productboard.com/hc/en-us/articles/360058212333-Add-features-to-your-hierarchy |
| Shortcut – Stories | Story als Dialog: links Inhalt (Beschreibung, Subtasks, Kommentare), rechts Feldspalte | https://www.shortcut.com/help/stories/stories-overview/ |
| Shortcut – Stories Page | Kanban/Tabelle mit Dichte-Stufen (Title only bis Jumbo) für den Sofortüberblick auf Karten | https://www.shortcut.com/help/stories/stories-page/ |
| GitHub Projects | Board-/Tabellen-Layouts; Items öffnen in einem Side Panel neben der Ansicht | https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/about-projects |
| GitHub Projects – Board-Layout | Karten in Spalten, Felder auf der Karte konfigurierbar | https://docs.github.com/en/issues/planning-and-tracking-with-projects/customizing-views-in-your-project/customizing-the-board-layout |
| Kiro – Specs | Spec als drei Dokumente: requirements.md (User Stories + EARS-Kriterien), design.md, tasks.md mit Live-Status | https://kiro.dev/docs/specs/ |
| Kiro – Requirements-First | Phasen Requirements → Design → Tasks, der Mensch prüft jede Phase | https://kiro.dev/docs/specs/feature-specs/requirements-first/ |
| Figma – Dev Mode | Design + Inspect-Panel rechts: Werte zum ausgewählten Element daneben | https://help.figma.com/hc/en-us/articles/15023124644247-Guide-to-Dev-Mode-in-Figma |
| Figma – Dev Mode focus view | Ein Design isoliert öffnen, Details/Status daneben, „Mark as completed“ | https://help.figma.com/hc/en-us/articles/23919923330455-Dev-Mode-focus-view |
| StoriesOnBoard – Story Mapping | Story Map: Backbone aus Aktivitäten und User Steps horizontal, Stories darunter | https://docs.storiesonboard.com/en/articles/14422387-user-story-mapping-101 |
| Aha! Roadmaps – User Story Maps | Journey Steps horizontal, Epics/Features darunter, Personas zuordenbar | https://support.aha.io/aha-roadmaps/support-articles/features/user-story-maps~7444651352110971462 |
| Microsoft – List/details | Muster-Doku Master-Detail: Liste links, Details rechts, auf schmalen Fenstern gestapelt | https://learn.microsoft.com/en-us/windows/apps/design/controls/list-details |
| Material 3 – Side sheets | Side Sheet für Zusatzinhalt neben dem Hauptinhalt, modal oder fest | https://m3.material.io/components/side-sheets/overview |
| NN/g – Cards | Karten als Einstieg mit Sofortüberblick, gut zum Scannen, schlecht bei vielen Einträgen | https://www.nngroup.com/articles/cards-component/ |
| NN/g – Progressive Disclosure | Wichtiges zuerst, Details auf Abruf | https://www.nngroup.com/articles/progressive-disclosure/ |

## Was daraus für artisign folgt

- Fast alle Tracker (Linear, Jira, Notion, Productboard, GitHub) lösen „Überblick + Details“ mit Master-Detail oder Side Peek. Das ist vertraut, zeigt aber Text, keine Screens.
- Story Maps (StoriesOnBoard, Aha!) zeigen den Ablauf horizontal. Das passt zu artisign-Flows, weil jeder Schritt auf einen Screen zeigt.
- Figma Dev Mode zeigt Design und Detailwerte nebeneinander. artisign hat das als „Show on screens“ schon, aber getrennt von der Spec-Ansicht.
- Kiro trennt Requirements, Design und Tasks in Dokumente. artisign hat Use Case und Screens in einem Modell und kann beides in einer Ansicht zeigen.
