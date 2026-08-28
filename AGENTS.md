# Marknote — agent guide

Marknote is a local-first markdown notes app (macOS, Electron + a small Node server).
Notes are plain `.md` files in `notes/` — there is no database. The app serves a web UI
and file API at `http://localhost:4747` while running.

Two ways for an agent to create or edit content:

1. **Write files directly** (preferred when working in this repo). The server reads disk
   on every request, so changes appear in the app immediately — the user may need ⌘R
   if the note is currently open.
2. **Call the HTTP API** (when the app is running) — see the endpoint table below. The
   API keeps front-matter `modified:` timestamps correct automatically on PUT.

## Note file format

`notes/<Title>.md` — the filename (minus `.md`) should match the front-matter title.
Titles must not contain `/`, `\` or `:`. To rename, use the API's rename endpoint —
it also rewrites incoming links from other notes.

```markdown
---
tags: [Label One, LabelTwo]
title: 'The Title'
created: '2026-08-26T09:00:00.000Z'
modified: '2026-08-26T09:00:00.000Z'
pinned: true
---

# The Title

Body markdown…
```

- `tags` — inline list, doubles as the sidebar "Labels". Optional. Common labels:
  `Meeting`, `Presentation`.
- `created` / `modified` — quoted ISO-8601 strings. On API PUT, `modified` is updated
  server-side; when writing files directly, set it yourself.
- `pinned: true` — optional; keeps the note at the top of the list.

## Markdown that renders specially

- GitHub-flavored markdown; single newlines render as line breaks.
- Task lists `- [ ]` — checkboxes are clickable in the app and save back to the file.
- ```mermaid fences render as diagrams (mermaid v11).
- `[[Note Title]]` — link to another note (matched by title, case-insensitive).
  Backlinks are computed automatically.
- `![[Note Title]]` — **transclusion**: splices that note's body in place (3 levels max).
- `@attachment/<file>` — refers to `attachments/<file>`. Use in image/link syntax:
  `![](@attachment/shot.png)`, `[clip](@attachment/rec.weba)`. Also valid inside mermaid
  image nodes: `A@{ img: "@attachment/x.png", w: 120, h: 80 }`.
- Audio attachment links (`.weba/.mp3/.m4a/.wav/.ogg`) render as players; video files
  as `<video>`; a YouTube/Vimeo URL **alone on its own line** becomes an embedded player.
- 3D models: a standalone link to a `.glb`/`.gltf` attachment renders as an interactive
  viewer (orbit/auto-rotate), in notes and on slides. Uploading a `.blend` converts it
  to `.glb` automatically when Blender is installed (source file is kept).
- Avoid spaces/parens in new attachment filenames (uploads are sanitized to dashes).
- Colored text: inline HTML `<span style="color:#2b6cb0">text</span>` — renders in
  notes, slides and previews (GitHub's web view strips inline styles, though).

## Presentations

A note becomes a deck when it has `---` slide breaks (outside code fences), deck
directives, or the `Presentation` tag. Slides are markdown; everything above renders
on slides too. Skeleton:

```markdown
---
tags: [Presentation]
title: 'Quarterly review'
created: '2026-08-26T09:00:00.000Z'
modified: '2026-08-26T09:00:00.000Z'
---

<!-- transition: slide -->

# Quarterly review

Subtitle line

---

## Key points

<!-- steps -->

- Bullets appear
- one keypress at a time

---

## Composed from another note

![[Some other note]]
```

Directives (HTML comments — invisible in normal note view):

| Directive | Scope | Effect |
| --------- | ----- | ------ |
| `<!-- transition: slide\|fade\|zoom\|convex\|concave\|none -->` | deck / slide | on slide 1: the deck default; on any other slide: that slide's own transition |
| `<!-- steps -->` | slide | top-level bullets reveal one by one |
| `<!-- sound: @attachment/x.mp3 -->` | slide | plays when the slide appears |
| `<!-- background: #1f7a8c -->` | slide | background color for that slide (any CSS color) |
| `<!-- color: #ffffff -->` | slide | default text color for that slide |
| `<!-- music: <youtube url> -->` | deck | background music; starts when the slide carrying the directive is reached (slide 1 = from the beginning); a `?t=`/`&t=` in the URL (seconds or `1h2m3s`) sets the start position in the video |
| `<!-- notes ... -->` | slide | speaker notes (multiline OK) — invisible everywhere except the presenter view |

`![[Note]]` embeds contribute their own `---` breaks as extra slides. The user presents
via the Present button; the deck editor (Edit deck) is the interactive editing UI.
"Presenter mode" (note ⋯ menu) opens the deck in a display window — auto-placed
fullscreen on an external screen in the desktop app — while the main window shows
current/next slide, speaker notes, timer and controls, synced via BroadcastChannel.

## PDF export

⋯ menu → "Export PDF": regular notes become an A4 document, deck notes become
landscape slide pages (backgrounds included, mermaid rendered). The print views
are also plain URLs — `#print/<file>` and `#printdeck/<file>` — which browsers
can print directly.

## Meeting notes

Created by the app's recorder; agents may also assemble them. Shape:

```markdown
---
tags: [Meeting]
title: 'Meeting 2026-08-26 14:00'
…
---

# Meeting 2026-08-26 14:00
[Recording · 42:10](@attachment/Meeting-2026-08-26-14-00.weba)

## Notes
(typed during the meeting)

## Summary
(bullets: key topics, decisions, action items)

## Transcript
<details><summary>Show transcript</summary>

- **0:12** Anna: "…"
</details>
```

The transcribe button only shows while the note lacks `## Transcript`.

## Todos

`notes/Todos.md` holds the todo list as ordinary task-list lines; the app's
"☑ Todos" page (sidebar) renders them grouped by date. Line format:

```markdown
- [ ] Call Swedbank Pay about fas 0 @2026-08-27 !09:30 [[Some source note]]
```

- `@YYYY-MM-DD` — due date (groups: Overdue/Today/Tomorrow/This week/Later)
- `!HH:MM` — reminder: the server fires a macOS notification at that local time
  on the due date (only while the app runs; fired ones are recorded in
  `.todo-reminders.json` and never repeat; reminders >2h stale are swallowed)
- trailing `[[Note]]` — source-note link shown on the todo
- `- [x]` — done

Agents may append todo lines directly to the file. The note is created on first
use with the `Todos` tag; a `!time` without a date means today.

## HTTP API (base `http://localhost:4747`)

| Method & path | Body | Returns |
| ------------- | ---- | ------- |
| GET `/api/notes` | — | all notes: `{file,title,tags,pinned,created,modified,body}` |
| GET `/api/notes/<file>` | — | raw markdown incl. front matter |
| PUT `/api/notes/<file>` | raw markdown | saves; bumps `modified`; returns note object |
| POST `/api/notes` | `{"title"}` | creates note; returns `{file}` |
| DELETE `/api/notes/<file>` | — | moves to `.trash/` (never hard-deletes) |
| POST `/api/rename` | `{"file","title"}` | renames file+title+heading, fixes incoming links |
| POST `/api/attachments?name=<hint>` | binary | stores in `attachments/`; returns `{file}` |
| GET `/api/trash` · POST `/api/trash/restore` / `/api/trash/delete` | `{"file"}` | trash management |
| POST `/api/transcribe` | `{"file"}` (attachment) | whisper.cpp transcript, speaker-labelled |
| POST `/api/summarize` | `{"text","title"}` | meeting summary via local `claude` CLI |
| POST `/api/todo-suggest` | `{"text","title"}` | action items as `{suggestions:[…]}` via local `claude` CLI |

URL-encode filenames in paths. `<file>` is always a basename ending in `.md`.

## Conventions & gotchas

- Never hard-delete notes — DELETE moves to `.trash/`.
- The front-matter block's `---` delimiters are not slide breaks; slides split only
  after the front matter ends.
- macOS stores filenames NFD-decomposed; the API accepts NFC or NFD.
- The notes/attachments of a user are private data — read only what the task requires.
