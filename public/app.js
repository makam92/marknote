/* global marked, mermaid */

const $ = (id) => document.getElementById(id);

/* ——— theme ——— */

function effectiveTheme() {
  return (
    document.documentElement.dataset.theme ||
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  );
}

function initMermaid() {
  mermaid.initialize({
    startOnLoad: false,
    theme: effectiveTheme() === 'dark' ? 'dark' : 'neutral',
    fontFamily: 'Figtree, sans-serif',
    suppressErrorRendering: true
  });
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('theme', theme); } catch (e) { /* private mode */ }
  $('themeToggle').textContent = theme === 'dark' ? '☾' : '☀';
  initMermaid();
  // Re-render so mermaid diagrams pick up the new palette.
  if (state.current && !state.editing) renderMarkdown($('rendered'), state.current.body);
}

const state = {
  notes: [],
  current: null,      // note object from state.notes
  raw: null,          // full file content (front matter + body) while editing
  dirty: false,
  editing: false,
  query: '',
  tag: null,
  sort: 'modified'
};

const api = {
  async list() {
    const res = await fetch('/api/notes');
    return res.json();
  },
  async raw(file) {
    const res = await fetch('/api/notes/' + encodeURIComponent(file));
    if (!res.ok) throw new Error('note not found');
    return res.text();
  },
  async save(file, content) {
    const res = await fetch('/api/notes/' + encodeURIComponent(file), { method: 'PUT', body: content });
    if (!res.ok) throw new Error('save failed');
    return res.json();
  },
  async create(title) {
    const res = await fetch('/api/notes', { method: 'POST', body: JSON.stringify({ title }) });
    return res.json();
  },
  async rename(file, title) {
    const res = await fetch('/api/rename', { method: 'POST', body: JSON.stringify({ file, title }) });
    if (!res.ok) throw new Error('rename failed');
    return res.json();
  },
  async upload(blob, nameHint) {
    const res = await fetch('/api/attachments?name=' + encodeURIComponent(nameHint || ''), {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob
    });
    if (!res.ok) throw new Error('upload failed');
    return res.json();
  },
  async trash() {
    const res = await fetch('/api/trash');
    return res.json();
  },
  async trashAction(action, file) {
    const res = await fetch('/api/trash/' + action, { method: 'POST', body: JSON.stringify({ file }) });
    if (!res.ok) throw new Error(action + ' failed');
    return res.json();
  },
  async remove(file) {
    const res = await fetch('/api/notes/' + encodeURIComponent(file), { method: 'DELETE' });
    if (!res.ok) throw new Error('delete failed');
  }
};

/* ——— helpers ——— */

const escapeHtml = (s) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function formatDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const today = new Date();
  const days = Math.floor((today.setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
  if (days === 0) return 'today ' + d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
  if (days === 1) return 'yesterday';
  return d.toLocaleDateString('sv-SE');
}

// Notable-specific link syntax → app routes
function preprocess(md) {
  return md
    .replaceAll('](@attachment/', '](/attachments/')
    .replaceAll('src="@attachment/', 'src="/attachments/')
    // also covers mermaid image nodes: img: "@attachment/x.png"
    .replaceAll('"@attachment/', '"/attachments/')
    .replaceAll('](@note/', '](#note/')
    // markdown link destinations can't contain raw spaces — encode them so
    // attachment filenames with spaces still render
    .replace(/\]\(\/attachments\/([^)\n]+)\)/g, (m, p1) => '](/attachments/' + p1.replace(/ /g, '%20') + ')')
    // text alignment: ::: center|right|justify … ::: (Word-style blocks)
    .replace(/^:::[ \t]*(center|right|justify)[ \t]*$/gm, '<!--align:$1-->')
    .replace(/^:::[ \t]*$/gm, '<!--/align-->');
}

const canon = (s) => s.normalize('NFC').toLowerCase().trim();

// [[Note Title]] → note whose title (or filename) matches, case-insensitive.
function resolveNote(title) {
  const t = canon(title);
  return (
    state.notes.find((n) => canon(n.title) === t) ||
    state.notes.find((n) => canon(n.file.replace(/\.md$/, '')) === t)
  );
}

// Turn [[...]] in rendered text nodes into note links (skipping code and diagrams).
function linkifyWikiLinks(el) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.parentElement.closest('code, pre, a, .mermaid')) return NodeFilter.FILTER_REJECT;
      return /\[\[[^\]\n]+\]\]/.test(node.nodeValue)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP;
    }
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
      frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const title = m[1].trim();
      const target = resolveNote(title);
      const a = document.createElement('a');
      a.textContent = title;
      if (target) {
        a.className = 'wikilink';
        a.href = '#note/' + encodeURIComponent(target.file);
      } else {
        a.className = 'wikilink broken';
        a.title = `No note called “${title}”`;
      }
      frag.appendChild(a);
      last = m.index + m[0].length;
    }
    frag.appendChild(document.createTextNode(text.slice(last)));
    node.replaceWith(frag);
  }
}

function youtubeId(href) {
  let m = href.match(/^https?:\/\/(?:www\.|m\.)?youtube\.com\/(?:watch|playlist)\?/);
  if (m) {
    const v = href.match(/[?&]v=([\w-]{6,20})/);
    return v ? v[1] : null;
  }
  m = href.match(/^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:shorts|embed|live)\/|youtu\.be\/)([\w-]{6,20})/);
  return m ? m[1] : null;
}

// A video link alone on its line (bare pasted URL included) becomes a player.
// Links inside a sentence stay ordinary links.
function embedVideos(el) {
  el.querySelectorAll('a[href]').forEach((a) => {
    if (a.closest('li, table')) return;
    const prevOk = (() => {
      let s = a.previousSibling;
      while (s && s.nodeType === Node.TEXT_NODE && !s.textContent.trim()) s = s.previousSibling;
      return !s || (s.nodeType === Node.ELEMENT_NODE && s.tagName === 'BR');
    })();
    const nextOk = (() => {
      let s = a.nextSibling;
      while (s && s.nodeType === Node.TEXT_NODE && !s.textContent.trim()) s = s.nextSibling;
      return !s || (s.nodeType === Node.ELEMENT_NODE && s.tagName === 'BR');
    })();
    if (!prevOk || !nextOk) return;

    const href = a.getAttribute('href');
    const yt = youtubeId(href);
    const vimeo = href.match(/^https?:\/\/(?:www\.)?vimeo\.com\/(\d+)/);
    const isFile = /\.(mp4|webm|mov|m4v)([?#]|$)/i.test(href);
    const isAudio = /\.(weba|mp3|m4a|wav|ogg)([?#]|$)/i.test(href);
    const isModel = /\.(glb|gltf)([?#]|$)/i.test(href);
    if (!yt && !vimeo && !isFile && !isAudio && !isModel) return;

    let embed;
    if (isModel) {
      embed = document.createElement('model-viewer');
      embed.className = 'model-embed';
      embed.setAttribute('src', href);
      embed.setAttribute('camera-controls', '');
      embed.setAttribute('auto-rotate', '');
      embed.setAttribute('shadow-intensity', '1');
      // lazy-load heuristics misfire inside reveal's transformed slides
      embed.setAttribute('loading', 'eager');
      embed.setAttribute('alt', a.textContent || '3D-modell');
    } else if (isAudio) {
      embed = document.createElement('span');
      embed.className = 'audio-embed';
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'metadata';
      audio.src = href;
      embed.appendChild(audio);
      const dur = document.createElement('span');
      dur.className = 'audio-dur';
      embed.appendChild(dur);
      const showDur = (secs) => {
        const m = Math.floor(secs / 60);
        const rest = Math.round(secs % 60);
        dur.textContent = m >= 60
          ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
          : `${m}:${String(rest).padStart(2, '0')}`;
      };
      audio.addEventListener('loadedmetadata', () => {
        if (isFinite(audio.duration)) return showDur(audio.duration);
        // Legacy MediaRecorder files report Infinity — force a seek to learn it.
        const onchange = () => {
          if (isFinite(audio.duration) && audio.duration > 0) {
            audio.removeEventListener('durationchange', onchange);
            showDur(audio.duration);
            audio.currentTime = 0;
          }
        };
        audio.addEventListener('durationchange', onchange);
        audio.currentTime = 1e10;
      });
      if (state.current && !state.current.body.includes('## Transcript')) {
        const btn = document.createElement('button');
        btn.className = 'transcribe-btn';
        btn.dataset.src = href;
        btn.textContent = 'Transcribe & summarize';
        embed.appendChild(btn);
      }
    } else if (isFile) {
      embed = document.createElement('video');
      embed.controls = true;
      embed.preload = 'metadata';
      embed.src = href;
    } else {
      embed = document.createElement('div');
      embed.className = 'video-embed';
      const iframe = document.createElement('iframe');
      iframe.src = yt
        ? 'https://www.youtube-nocookie.com/embed/' + yt
        : 'https://player.vimeo.com/video/' + vimeo[1];
      iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
      iframe.allowFullscreen = true;
      iframe.title = 'Video';
      embed.appendChild(iframe);
    }
    a.replaceWith(embed);
  });

  // ![](@attachment/clip.mp4) comes out of markdown as a broken <img> — make it a player.
  el.querySelectorAll('img[src]').forEach((img) => {
    if (!/\.(mp4|webm|mov|m4v)([?#]|$)/i.test(img.getAttribute('src'))) return;
    const video = document.createElement('video');
    video.controls = true;
    video.preload = 'metadata';
    video.src = img.getAttribute('src');
    img.replaceWith(video);
  });
}

// ![[Note Title]] splices another note's body in place (max 3 levels deep).
function expandTransclusions(text, depth = 0, seen = new Set()) {
  if (depth > 2) return text;
  return text.replace(/!\[\[([^\]\n]+)\]\]/g, (m, name) => {
    const target = resolveNote(name.trim());
    if (!target || seen.has(target.file)) return m;
    if (isLockedBody(target.body)) return `🔒 *${target.title} (locked)*`;
    const nextSeen = new Set(seen);
    nextSeen.add(target.file);
    return expandTransclusions(target.body, depth + 1, nextSeen);
  });
}

// Deterministic mermaid for slides/previews: mermaid.render doesn't care
// whether the container is hidden, unlike mermaid.run which measures 0×0
// inside reveal's non-active slides.
let staticMmSeq = 0;
async function renderMermaidStatic(el) {
  for (const node of [...el.querySelectorAll('.mermaid')]) {
    const code = node.textContent;
    const fresh = document.createElement('div');
    fresh.className = 'mermaid';
    node.replaceWith(fresh);
    try {
      const { svg } = await mermaid.render(
        'staticmm' + ++staticMmSeq,
        code.replaceAll('"@attachment/', '"/attachments/')
      );
      fresh.innerHTML = svg;
    } catch (e) {
      fresh.innerHTML = '<div class="thumb-diagram">◇ diagram error</div>';
    }
  }
}

function renderMarkdown(el, body, opts = {}) {
  // breaks: true — a single newline renders as a line break, like Notable did.
  el.innerHTML = marked.parse(preprocess(expandTransclusions(body)), { gfm: true, breaks: true });
  applyAlignBlocks(el);
  linkifyWikiLinks(el);
  embedVideos(el);
  el.querySelectorAll('pre > code.language-mermaid').forEach((code, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'mermaid-wrap';
    const div = document.createElement('div');
    div.className = 'mermaid';
    div.textContent = code.textContent;
    const edit = document.createElement('button');
    edit.className = 'diagram-edit';
    edit.dataset.index = i;
    edit.textContent = 'Edit';
    edit.title = 'Edit this diagram';
    wrap.append(div, edit);
    code.closest('pre').replaceWith(wrap);
  });
  // Static contexts (slides, deck preview) render diagrams themselves via
  // renderMermaidStatic — mermaid.run would race them for the source text.
  const diagrams = el.querySelectorAll('.mermaid');
  if (diagrams.length && !opts.staticMermaid) mermaid.run({ nodes: diagrams }).catch(() => {});
  el.querySelectorAll('input[type="checkbox"]').forEach((box, i) => {
    box.removeAttribute('disabled');
    box.dataset.taskIndex = i;
  });
  el.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (href.startsWith('#note/')) {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        openNote(decodeURIComponent(href.slice('#note/'.length)));
      });
    } else if (/^https?:/i.test(href)) {
      a.target = '_blank';
      a.rel = 'noopener';
    }
  });
}

/* ——— note list ——— */

function visibleNotes() {
  const q = state.query.trim().toLowerCase();
  let notes = state.notes.filter((n) => {
    if (state.tag && !n.tags.includes(state.tag)) return false;
    if (!q) return true;
    return (
      n.title.toLowerCase().includes(q) ||
      n.tags.some((t) => t.toLowerCase().includes(q)) ||
      n.body.toLowerCase().includes(q)
    );
  });
  const pin = (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
  if (q) {
    const score = (n) =>
      (n.title.toLowerCase().includes(q) ? 4 : 0) +
      (n.tags.some((t) => t.toLowerCase().includes(q)) ? 2 : 0) +
      (n.body.toLowerCase().includes(q) ? 1 : 0);
    notes.sort((a, b) => score(b) - score(a) || new Date(b.modified) - new Date(a.modified));
  } else if (state.sort === 'title') {
    notes.sort((a, b) => pin(a, b) || a.title.localeCompare(b.title, 'sv'));
  } else {
    notes.sort((a, b) => pin(a, b) || new Date(b.modified) - new Date(a.modified));
  }
  return notes;
}

function snippetFor(note, q) {
  if (isLockedBody(note.body)) return '🔒';
  if (!q) {
    const line = note.body.split('\n').find((l) => l.trim() && !l.startsWith('#'));
    return line ? escapeHtml(line.trim().slice(0, 90)) : '';
  }
  const idx = note.body.toLowerCase().indexOf(q);
  if (idx === -1) return '';
  const start = Math.max(0, idx - 30);
  const chunk = note.body.slice(start, idx + q.length + 60).replace(/\n/g, ' ');
  const rel = idx - start;
  return (
    (start > 0 ? '…' : '') +
    escapeHtml(chunk.slice(0, rel)) +
    '<mark>' + escapeHtml(chunk.slice(rel, rel + q.length)) + '</mark>' +
    escapeHtml(chunk.slice(rel + q.length))
  );
}

function renderList() {
  const q = state.query.trim().toLowerCase();
  const notes = visibleNotes();
  const list = $('noteList');
  $('noteCount').textContent = `${notes.length} note${notes.length === 1 ? '' : 's'}`;

  if (!notes.length) {
    list.innerHTML = '<div class="no-results">Nothing found.</div>';
    return;
  }
  list.innerHTML = notes
    .map((n) => {
      const active = state.current && state.current.file === n.file ? ' active' : '';
      const snippet = snippetFor(n, q);
      return `<button class="note-item${active}" data-file="${escapeHtml(n.file)}">
        <span class="t">${n.pinned ? '<span class="pin-mark">★</span>' : ''}${escapeHtml(n.title)}</span>
        <span class="d">${formatDate(n.modified)}</span>
        ${snippet ? `<span class="snippet">${snippet}</span>` : ''}
      </button>`;
    })
    .join('');
}

function tagCounts() {
  const counts = new Map();
  for (const n of state.notes) for (const t of n.tags) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'sv'));
}

function renderTags() {
  const collapsed = (() => {
    try { return localStorage.getItem('labelsCollapsed') === '1'; } catch (e) { return false; }
  })();
  $('labelsChevron').textContent = collapsed ? '▸' : '▾';
  const list = $('labelList');
  list.hidden = collapsed;
  if (collapsed) return;
  const rows = tagCounts().map(
    ([tag, count]) =>
      `<button class="label-row${state.tag === tag ? ' active' : ''}" data-tag="${escapeHtml(tag)}">
        <span class="label-name">${escapeHtml(tag)}</span><span class="label-count">${count}</span>
      </button>`
  );
  list.innerHTML =
    `<button class="label-row${state.tag === null ? ' active' : ''}" data-all="1">
      <span class="label-name">All notes</span><span class="label-count">${state.notes.length}</span>
    </button>` + rows.join('');
}

/* ——— note view ——— */

/* ——— pin & rename ——— */

function setPinnedInRaw(raw, pinned) {
  const line = pinned ? 'pinned: true' : null;
  if (raw.startsWith('---')) {
    const end = raw.indexOf('\n---', 3);
    if (end !== -1) {
      const headerStart = raw.indexOf('\n') + 1;
      const lines = raw.slice(headerStart, end).split('\n').filter((l) => !/^pinned:/.test(l));
      if (line) lines.unshift(line);
      return raw.slice(0, headerStart) + lines.join('\n') + raw.slice(end);
    }
  }
  return line ? `---\n${line}\n---\n\n` + raw : raw;
}

async function togglePin() {
  const raw = await api.raw(state.current.file);
  const updated = await api.save(state.current.file, setPinnedInRaw(raw, !state.current.pinned));
  applySaved(updated);
  $('pinBtn').classList.toggle('pinned', !!updated.pinned);
  $('pinBtn').title = updated.pinned ? 'Unpin' : 'Pin — keep this note at the top of the list';
  $('noteDate').textContent = formatDate(updated.modified);
}

$('pinBtn').addEventListener('click', togglePin);

function openRename() {
  $('renameWrap').hidden = false;
  const input = $('renameInput');
  input.value = state.current.title;
  input.focus();
  input.select();
}

async function commitRename() {
  const title = $('renameInput').value.trim();
  $('renameWrap').hidden = true;
  if (!title || title === state.current.title) return;
  const renamed = await api.rename(state.current.file, title);
  // Other notes' bodies may have changed (link fixes) — reload everything.
  state.notes = await api.list();
  renderTags();
  renderList();
  openNote(renamed.file);
  const el = $('saveState');
  el.textContent = renamed.linkUpdates
    ? `renamed · ${renamed.linkUpdates} link${renamed.linkUpdates === 1 ? '' : 's'} updated`
    : 'renamed';
  setTimeout(() => { if (!state.dirty) el.textContent = ''; }, 3000);
}

$('renameBtn').addEventListener('click', openRename);
$('renameInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') commitRename();
  else if (e.key === 'Escape') $('renameWrap').hidden = true;
});
$('renameInput').addEventListener('blur', () => { $('renameWrap').hidden = true; });

/* ——— header label editor ——— */

// Rewrite (or create) the front-matter tags line, preserving everything else.
function setTagsInRaw(raw, tags) {
  const line = tags.length ? `tags: [${tags.join(', ')}]` : null;
  if (raw.startsWith('---')) {
    const end = raw.indexOf('\n---', 3);
    if (end !== -1) {
      const header = raw.slice(raw.indexOf('\n') + 1, end);
      // Drop the old tags entry (inline or block-list form), keep other keys.
      const lines = header.split('\n').filter((l) => !/^tags:/.test(l) && !/^\s+- /.test(l));
      if (line) lines.unshift(line);
      return '---\n' + lines.join('\n') + raw.slice(end);
    }
  }
  return line ? `---\n${line}\n---\n\n` + raw : raw;
}

async function saveTags(tags) {
  const raw = await api.raw(state.current.file);
  const updated = await api.save(state.current.file, setTagsInRaw(raw, tags));
  applySaved(updated);
  renderHeaderTags(updated);
  $('noteDate').textContent = formatDate(updated.modified);
}

const cleanTag = (t) => t.replace(/[,[\]:#'"]/g, '').trim();

let tagSel = -1; // highlighted row in the label suggestion dropdown

function renderHeaderTags(note) {
  $('noteTags').innerHTML =
    note.tags
      .map(
        (t) => `<span class="htag"><button class="htag-name" data-filter="${escapeHtml(t)}"
          title="Filter by this label">${escapeHtml(t)}</button><button class="htag-x"
          data-remove="${escapeHtml(t)}" title="Remove label">×</button></span>`
      )
      .join('') +
    `<button id="tagAddBtn" class="tag-add-btn" title="Add a label">+ Label</button>
     <span id="tagAddWrap" class="tag-add-wrap" hidden>
       <input id="tagInput" placeholder="Label…" autocomplete="off" spellcheck="false">
       <div id="tagSuggest" class="tag-suggest" hidden></div>
     </span>`;
}

function tagSuggestions() {
  const q = canon($('tagInput').value);
  return tagCounts()
    .map(([t]) => t)
    .filter((t) => !state.current.tags.includes(t) && canon(t).includes(q))
    .slice(0, 8);
}

function renderTagSuggest() {
  const box = $('tagSuggest');
  const items = tagSuggestions();
  box.hidden = items.length === 0;
  box.innerHTML = items
    .map(
      (t, i) =>
        `<button class="suggest-item${i === tagSel ? ' active' : ''}" data-add="${escapeHtml(t)}">${escapeHtml(t)}</button>`
    )
    .join('');
}

function openTagInput() {
  $('tagAddBtn').hidden = true;
  $('tagAddWrap').hidden = false;
  tagSel = -1;
  renderTagSuggest();
  $('tagInput').focus();
}

function closeTagInput() {
  const wrap = $('tagAddWrap');
  if (wrap) {
    wrap.hidden = true;
    $('tagAddBtn').hidden = false;
    $('tagInput').value = '';
  }
}

async function addTag(t) {
  t = cleanTag(t);
  if (!t || state.current.tags.includes(t)) return closeTagInput();
  closeTagInput();
  await saveTags([...state.current.tags, t]);
}

$('noteTags').addEventListener('click', (e) => {
  const remove = e.target.closest('[data-remove]');
  const filter = e.target.closest('[data-filter]');
  const add = e.target.closest('[data-add]');
  if (remove) {
    saveTags(state.current.tags.filter((t) => t !== remove.dataset.remove));
  } else if (filter) {
    state.tag = state.tag === filter.dataset.filter ? null : filter.dataset.filter;
    renderTags();
    renderList();
  } else if (add) {
    addTag(add.dataset.add);
  } else if (e.target.closest('#tagAddBtn')) {
    openTagInput();
  }
});

// The input is re-created on every render, so listen via delegation.
$('noteTags').addEventListener('input', (e) => {
  if (e.target.id === 'tagInput') {
    tagSel = -1;
    renderTagSuggest();
  }
});
$('noteTags').addEventListener('keydown', (e) => {
  if (e.target.id !== 'tagInput') return;
  const items = tagSuggestions();
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (items.length) {
      tagSel = e.key === 'ArrowDown'
        ? (tagSel + 1) % items.length
        : tagSel <= 0 ? items.length - 1 : tagSel - 1;
      renderTagSuggest();
    }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    addTag(tagSel >= 0 && items[tagSel] ? items[tagSel] : e.target.value);
  } else if (e.key === 'Escape') {
    closeTagInput();
  }
});
$('noteTags').addEventListener('focusout', (e) => {
  if (e.target.id === 'tagInput') setTimeout(closeTagInput, 150);
});
$('noteTags').addEventListener('mousedown', (e) => {
  if (e.target.closest('.tag-suggest')) e.preventDefault();
});

// Notes that reference this one via [[Title]] or Notable's @note/file syntax.
function renderBacklinks(note) {
  const el = $('backlinks');
  const title = canon(note.title);
  const links = state.notes.filter((n) => {
    if (n.file === note.file) return false;
    return canon(n.body).includes('[[' + title + ']]') || n.body.includes('@note/' + note.file);
  });
  el.hidden = links.length === 0;
  el.innerHTML = links.length
    ? '<span class="backlinks-label">Linked from</span>' +
      links
        .map((n) => `<button class="backlink" data-file="${escapeHtml(n.file)}">${escapeHtml(n.title)}</button>`)
        .join('')
    : '';
}

$('backlinks').addEventListener('click', (e) => {
  const btn = e.target.closest('.backlink');
  if (btn) openNote(btn.dataset.file);
});

function showNote(note) {
  // Never drop unsaved edits when something switches notes mid-edit.
  if (state.editing && state.dirty && state.current && state.current.file !== note.file) {
    const file = state.current.file;
    api.save(file, $('editor').value).then((updated) => {
      const i = state.notes.findIndex((n) => n.file === updated.file);
      if (i !== -1) state.notes[i] = updated;
      renderTags();
      renderList();
    });
  }
  state.current = note;
  state.editing = false;
  state.raw = null;
  setDirty(false);
  $('empty').hidden = true;
  $('noteView').hidden = false;
  $('trashView').hidden = true;
  $('meetingView').hidden = true;
  $('todoView').hidden = true;
  $('renameWrap').hidden = true;
  $('editorWrap').hidden = true;
  $('rendered').hidden = false;
  $('pinBtn').classList.toggle('pinned', !!note.pinned);
  $('pinBtn').title = note.pinned ? 'Unpin' : 'Pin — keep this note at the top of the list';
  $('noteMenu').hidden = true;
  $('deckBtn').hidden = !isDeckNote(note);
  $('presenterBtn').hidden = !isDeckNote(note);
  // any note with real content can yield todos — plans and research included
  $('todoSuggestBtn').hidden = !note.body || note.body.trim().length < 80 || isLockedBody(note.body);
  updateLockMenu(note);
  closeFind();
  renderBacklinks(note);
  $('editBtn').textContent = 'Edit';
  resetDelete();
  $('noteDate').textContent = formatDate(note.modified);
  renderHeaderTags(note);
  renderNoteBody(note);
  document.title = note.title + ' — Marknote';
  history.replaceState(null, '', '#note/' + encodeURIComponent(note.file));
  $('noteView').closest('.main').scrollTop = 0;
  renderList();
}

function openNote(file) {
  const note = state.notes.find((n) => n.file === file || n.title === file.replace(/\.md$/, ''));
  if (note) showNote(note);
}

function setDirty(dirty) {
  state.dirty = dirty;
  const el = $('saveState');
  el.textContent = dirty ? 'unsaved' : '';
  el.classList.toggle('dirty', dirty);
}

function applySaved(updated) {
  const i = state.notes.findIndex((n) => n.file === updated.file);
  if (i !== -1) state.notes[i] = updated;
  state.current = updated;
  setDirty(false);
  $('saveState').textContent = 'saved';
  setTimeout(() => { if (!state.dirty) $('saveState').textContent = ''; }, 1500);
  renderTags();
  renderList();
}

async function enterEdit() {
  state.raw = await api.raw(state.current.file);
  if (isLockedBody(state.current.body)) {
    const u = unlockedNotes.get(state.current.file);
    if (!u) {
      alertBar('Unlock the note first');
      const pw = $('rendered').querySelector('.lock-pass');
      if (pw) pw.focus();
      return;
    }
    const fmEnd = frontmatterEndIndex(state.raw);
    state.raw = state.raw.slice(0, fmEnd) + '\n' + u.plain;
  }
  state.editing = true;
  $('editor').value = state.raw;
  $('rendered').hidden = true;
  $('editorWrap').hidden = false;
  $('backlinks').hidden = true;
  $('editBtn').textContent = 'Preview';
  $('editor').focus();
}

async function exitEdit({ save }) {
  if (save && state.dirty) {
    const updated = await api.save(state.current.file, await rawForSave($('editor').value));
    applySaved(updated);
  }
  setDirty(false);
  state.editing = false;
  closeSuggest();
  $('editorWrap').hidden = true;
  $('rendered').hidden = false;
  $('editBtn').textContent = 'Edit';
  $('noteDate').textContent = formatDate(state.current.modified);
  renderHeaderTags(state.current);
  renderNoteBody(state.current);
  renderBacklinks(state.current);
  if (pendingRelock === state.current.file) {
    pendingRelock = null;
    autoLock(state.current.file);
  }
}

async function saveEditor() {
  if (!state.editing || !state.dirty) return;
  const updated = await api.save(state.current.file, await rawForSave($('editor').value));
  applySaved(updated);
}

// Toggling a rendered checkbox flips the matching "- [ ]" in the source and saves.
async function toggleTask(taskIndex) {
  const raw = await api.raw(state.current.file);
  const re = /^([ \t]*(?:[-*+]|\d+\.)\s+)\[( |x|X)\]/gm;
  let i = -1;
  const next = raw.replace(re, (match, prefix, mark) => {
    i += 1;
    if (i !== taskIndex) return match;
    return prefix + (mark === ' ' ? '[x]' : '[ ]');
  });
  if (next === raw) return;
  const updated = await api.save(state.current.file, next);
  const scroll = $('noteView').closest('.main').scrollTop;
  applySaved(updated);
  renderMarkdown($('rendered'), updated.body);
  $('noteDate').textContent = formatDate(updated.modified);
  $('noteView').closest('.main').scrollTop = scroll;
}

/* ——— delete (two-click confirm, no dialogs) ——— */

let deleteArmed = false;
function resetDelete() {
  deleteArmed = false;
  const btn = $('deleteBtn');
  btn.textContent = 'Delete';
  btn.classList.remove('confirming');
}

async function handleDelete() {
  const btn = $('deleteBtn');
  if (!deleteArmed) {
    deleteArmed = true;
    btn.textContent = 'Really delete?';
    btn.classList.add('confirming');
    setTimeout(resetDelete, 3000);
    return;
  }
  const file = state.current.file;
  await api.remove(file);
  refreshTrashCount();
  state.notes = state.notes.filter((n) => n.file !== file);
  state.current = null;
  state.editing = false;
  setDirty(false);
  resetDelete();
  $('noteView').hidden = true;
  $('empty').hidden = false;
  document.title = 'Marknote';
  history.replaceState(null, '', '#');
  renderTags();
  renderList();
}

/* ——— events ——— */

$('noteList').addEventListener('click', (e) => {
  const item = e.target.closest('.note-item');
  if (item) openNote(item.dataset.file);
});

$('labelList').addEventListener('click', (e) => {
  const row = e.target.closest('.label-row');
  if (!row) return;
  state.tag = row.dataset.all || state.tag === row.dataset.tag ? null : row.dataset.tag;
  renderTags();
  renderList();
});

$('labelsHead').addEventListener('click', () => {
  try {
    const collapsed = localStorage.getItem('labelsCollapsed') === '1';
    localStorage.setItem('labelsCollapsed', collapsed ? '0' : '1');
  } catch (e) { /* private mode */ }
  renderTags();
});

$('search').addEventListener('input', (e) => {
  state.query = e.target.value;
  renderList();
});

$('sortModified').addEventListener('click', () => {
  state.sort = 'modified';
  $('sortModified').classList.add('active');
  $('sortTitle').classList.remove('active');
  renderList();
});
$('sortTitle').addEventListener('click', () => {
  state.sort = 'title';
  $('sortTitle').classList.add('active');
  $('sortModified').classList.remove('active');
  renderList();
});

$('editBtn').addEventListener('click', () => (state.editing ? exitEdit({ save: true }) : enterEdit()));
$('deleteBtn').addEventListener('click', handleDelete);

$('editor').addEventListener('input', () => setDirty(true));

/* ——— editor formatting toolbar ——— */

const ed = $('editor');

// Replace [from, to) with text via execCommand so the edit lands in the
// browser's undo stack — setRangeText edits can't be undone with ⌘Z.
function edReplace(from, to, text) {
  ed.focus();
  ed.setSelectionRange(from, to);
  if (text) document.execCommand('insertText', false, text);
  else document.execCommand('delete');
}

// The textarea the formatting toolbar currently targets — the main editor,
// or the deck editor's slide pane while that modal is open.
let tbBox = null;
const tbb = () => tbBox || ed;

function tbReplace(from, to, text) {
  const box = tbb();
  box.focus();
  box.setSelectionRange(from, to);
  if (text) document.execCommand('insertText', false, text);
  else document.execCommand('delete');
}

function tbDirty() {
  if (tbb() === ed) {
    setDirty(true);
  } else {
    deckEd.dirty = true;
    scheduleDeckPreview();
  }
}

// Wrap the selection (or a placeholder) in inline markers, e.g. **bold**.
function wrapSel(before, after, placeholder) {
  const box = tbb();
  const s = box.selectionStart;
  const e = box.selectionEnd;
  const sel = box.value.slice(s, e) || placeholder;
  tbReplace(s, e, before + sel + after);
  box.setSelectionRange(s + before.length, s + before.length + sel.length);
  tbDirty();
}

// Prefix every selected line (heading, list, quote). Applying the same prefix
// again removes it; applying a different one replaces the existing marker.
function prefixLines(prefix, opts = {}) {
  const box = tbb();
  const value = box.value;
  const lineStart = value.lastIndexOf('\n', box.selectionStart - 1) + 1;
  let lineEnd = value.indexOf('\n', box.selectionEnd);
  if (lineEnd === -1) lineEnd = value.length;
  const lines = value.slice(lineStart, lineEnd).split('\n');
  const re = opts.number
    ? /^\d+\.\s/
    : new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const allPrefixed = lines.every((l) => re.test(l));
  const marker = /^(#{1,6}\s+|>\s+|- \[[ xX]\]\s+|[-*+]\s+|\d+\.\s+)/;
  const next = lines
    .map((l, i) => {
      if (allPrefixed) return l.replace(re, '');
      return (opts.number ? `${i + 1}. ` : prefix) + l.replace(marker, '');
    })
    .join('\n');
  tbReplace(lineStart, lineEnd, next);
  box.setSelectionRange(lineStart, lineStart + next.length);
  tbDirty();
}

// Insert a block template at the cursor with a blank line before it,
// selecting [selFrom, selTo) within the block so typing replaces the placeholder.
function insertBlock(block, selFrom, selTo) {
  const box = tbb();
  const s = box.selectionStart;
  const before = box.value.slice(0, s);
  const pad = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  tbReplace(s, box.selectionEnd, pad + block);
  const base = s + pad.length;
  box.setSelectionRange(base + selFrom, base + (selTo ?? selFrom));
  tbDirty();
}

const toolbarActions = {
  bold: () => wrapSel('**', '**', 'bold'),
  italic: () => wrapSel('*', '*', 'italic'),
  strike: () => wrapSel('~~', '~~', 'strikethrough'),
  h1: () => prefixLines('# '),
  h2: () => prefixLines('## '),
  h3: () => prefixLines('### '),
  ul: () => prefixLines('- '),
  ol: () => prefixLines('1. ', { number: true }),
  task: () => prefixLines('- [ ] '),
  quote: () => prefixLines('> '),
  hr: () => insertBlock('---\n\n', 5),
  code: () => wrapSel('`', '`', 'code'),
  codeblock: () => {
    const box = tbb();
    const s = box.selectionStart;
    const sel = box.value.slice(s, box.selectionEnd);
    if (sel) {
      const before = box.value.slice(0, s);
      const pad = !before || before.endsWith('\n') ? '' : '\n';
      tbReplace(s, box.selectionEnd, pad + '```\n' + sel.replace(/\n$/, '') + '\n```\n');
      const langPos = s + pad.length + 3; // right after ``` so a language can be typed
      box.setSelectionRange(langPos, langPos);
      tbDirty();
    } else {
      insertBlock('```\ncode here\n```\n', 4, 13);
    }
  },
  mermaid: () => {
    const fence = fenceAtCursor(tbb());
    if (fence) {
      openMermaid(fence.code, 'Save', (code) => {
        tbReplace(fence.start, fence.end, code);
        tbDirty();
      });
    } else {
      openMermaid(MERMAID_TEMPLATES.flowchart, 'Insert', (code) => {
        insertBlock('```mermaid\n' + code + '\n```\n', 11 + code.length + 5);
        tbDirty();
      });
    }
  },
  notelink: () => {
    const box = tbb();
    const s = box.selectionStart;
    const sel = box.value.slice(s, box.selectionEnd);
    tbReplace(s, box.selectionEnd, '[[' + sel + ']]');
    box.setSelectionRange(s + 2 + sel.length, s + 2 + sel.length);
    tbDirty();
    updateSuggest(box);
  },
  link: () => {
    const box = tbb();
    const s = box.selectionStart;
    const sel = box.value.slice(s, box.selectionEnd);
    const label = sel || 'text';
    tbReplace(s, box.selectionEnd, '[' + label + '](url)');
    const urlStart = s + label.length + 3;
    if (sel) box.setSelectionRange(urlStart, urlStart + 3);
    else box.setSelectionRange(s + 1, s + 1 + label.length);
    tbDirty();
  },
  table: () => {
    const t = '| Column 1 | Column 2 |\n| -------- | -------- |\n|          |          |\n';
    insertBlock(t, 2, 10);
  },
  image: () => {
    const box = tbb();
    const s = box.selectionStart;
    const alt = box.value.slice(s, box.selectionEnd) || 'alt';
    tbReplace(s, box.selectionEnd, '![' + alt + '](@attachment/file.png)');
    const nameStart = s + alt.length + 4 + '@attachment/'.length;
    box.setSelectionRange(nameStart, nameStart + 'file.png'.length);
    tbDirty();
  }
};

/* ——— [[ note-link autocomplete ——— */

let suggest = { open: false, items: [], index: 0, start: 0 };

// Caret position in viewport coordinates, via an offscreen mirror of the textarea.
// The textarea the note-suggest dropdown is currently attached to
// (the main editor or the deck editor's slide pane).
let suggestBox = null;

function caretViewportPos(box) {
  const style = getComputedStyle(box);
  const mirror = document.createElement('div');
  for (const prop of [
    'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderLeftWidth', 'boxSizing', 'tabSize'
  ]) mirror.style[prop] = style[prop];
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordWrap = 'break-word';
  mirror.style.width = box.clientWidth + 'px';
  mirror.textContent = box.value.slice(0, box.selectionStart);
  const marker = document.createElement('span');
  marker.textContent = '​';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const top = marker.offsetTop;
  const left = marker.offsetLeft;
  mirror.remove();
  const rect = box.getBoundingClientRect();
  return {
    top: rect.top + top - box.scrollTop + (parseFloat(style.lineHeight) || 22),
    left: rect.left + left
  };
}

function closeSuggest() {
  suggest.open = false;
  $('noteSuggest').hidden = true;
}

function renderSuggest() {
  const panel = $('noteSuggest');
  panel.innerHTML = suggest.items
    .map(
      (n, i) =>
        `<button class="suggest-item${i === suggest.index ? ' active' : ''}" data-i="${i}">
          ${escapeHtml(n.title)}<span class="suggest-date">${formatDate(n.modified)}</span>
        </button>`
    )
    .join('');
  const pos = caretViewportPos(suggestBox);
  panel.hidden = false;
  panel.style.left = Math.max(8, Math.min(pos.left, window.innerWidth - panel.offsetWidth - 8)) + 'px';
  panel.style.top = Math.min(pos.top + 4, window.innerHeight - panel.offsetHeight - 8) + 'px';
}

function updateSuggest(box = ed) {
  const usable = box === ed ? state.editing : deckEd.open;
  if (!usable) return closeSuggest();
  const caret = box.selectionStart;
  if (caret !== box.selectionEnd) return closeSuggest();
  const m = box.value.slice(0, caret).match(/\[\[([^\][\n]*)$/);
  if (!m) return closeSuggest();
  const q = canon(m[1]);
  const items = state.notes
    .filter((n) => !state.current || n.file !== state.current.file)
    .filter((n) => canon(n.title).includes(q))
    .sort(
      (a, b) =>
        (canon(b.title).startsWith(q) ? 1 : 0) - (canon(a.title).startsWith(q) ? 1 : 0) ||
        new Date(b.modified) - new Date(a.modified)
    )
    .slice(0, 8);
  if (!items.length) return closeSuggest();
  suggestBox = box;
  suggest = { open: true, items, index: 0, start: caret - m[1].length };
  renderSuggest();
}

function acceptSuggest(note) {
  const box = suggestBox || ed;
  const caret = box.selectionStart;
  // Swallow a closing ]] that's already there (e.g. from the toolbar button).
  const trailing = box.value.slice(caret, caret + 2) === ']]' ? 2 : 0;
  box.focus();
  box.setSelectionRange(suggest.start, caret + trailing);
  document.execCommand('insertText', false, note.title + ']]');
  closeSuggest();
  if (box === ed) {
    setDirty(true);
  } else {
    deckEd.dirty = true;
    scheduleDeckPreview();
  }
}

$('noteSuggest').addEventListener('mousedown', (e) => e.preventDefault());
$('noteSuggest').addEventListener('click', (e) => {
  const btn = e.target.closest('.suggest-item');
  if (btn) acceptSuggest(suggest.items[Number(btn.dataset.i)]);
});

ed.addEventListener('input', () => updateSuggest(ed));
ed.addEventListener('click', () => updateSuggest(ed));
ed.addEventListener('blur', closeSuggest);
ed.addEventListener('scroll', closeSuggest);
window.addEventListener('resize', closeSuggest);

// Shared keyboard navigation for the dropdown; true = the key was handled.
function handleSuggestKeys(e) {
  if (!suggest.open) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const len = suggest.items.length;
    suggest.index = (suggest.index + (e.key === 'ArrowDown' ? 1 : len - 1)) % len;
    renderSuggest();
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    acceptSuggest(suggest.items[suggest.index]);
    return true;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    closeSuggest();
    return true;
  }
  return false;
}

/* ——— mermaid diagram editor ——— */

const MERMAID_TEMPLATES = {
  flowchart: `flowchart LR\n  A[Start] --> B{Decision?}\n  B -- yes --> C[Do the thing]\n  B -- no --> D[Skip it]\n  C --> E[Done]\n  D --> E`,
  image: `flowchart LR\n  A@{ img: "/notes-icon.png", label: "Swap img for @attachment or a URL", pos: "b", w: 80, h: 80 }\n  A --> B[Next step]`,
  sequence: `sequenceDiagram\n  participant U as User\n  participant A as App\n  participant S as Server\n  U->>A: Tap button\n  A->>S: POST /api/thing\n  S-->>A: 200 OK\n  A-->>U: Show result`,
  class: `classDiagram\n  class Animal {\n    +String name\n    +makeSound()\n  }\n  class Dog {\n    +fetch()\n  }\n  Animal <|-- Dog`,
  state: `stateDiagram-v2\n  [*] --> Idle\n  Idle --> Loading : fetch\n  Loading --> Ready : success\n  Loading --> Error : fail\n  Error --> Loading : retry\n  Ready --> [*]`,
  er: `erDiagram\n  USER ||--o{ ORDER : places\n  ORDER ||--|{ LINE_ITEM : contains\n  USER {\n    int id\n    string name\n  }`,
  gantt: `gantt\n  title Project plan\n  dateFormat YYYY-MM-DD\n  section Phase 1\n    Design :a1, 2026-09-01, 7d\n    Build  :after a1, 14d\n  section Phase 2\n    Test   :2026-09-22, 5d`,
  pie: `pie title Time spent\n  "Coding" : 45\n  "Meetings" : 30\n  "Coffee" : 25`,
  mindmap: `mindmap\n  root((Idea))\n    Branch A\n      Leaf 1\n      Leaf 2\n    Branch B\n      Leaf 3`,
  timeline: `timeline\n  title Project history\n  2024 : Started\n  2025 : First release\n  2026 : Big rewrite`,
  git: `gitGraph\n  commit\n  branch feature\n  checkout feature\n  commit\n  commit\n  checkout main\n  merge feature`
};

// Each row: [label, [insertable snippets]] — rendered as clickable chips
// that insert the snippet at the cursor in the code pane.
const MERMAID_CHEATS = {
  flowchart: [
    ['Direction', ['flowchart LR', 'flowchart TB']],
    ['Shapes', ['A[box]', 'B(rounded)', 'C{diamond}', 'D((circle))', 'E>flag]']],
    ['Links', ['A --> B', 'A -.-> B', 'A ==> B', 'A --- B', 'A -- text --> B']],
    ['Image node', ['A@{ img: "/attachments/x.png", label: "text", pos: "b", w: 120, h: 80 }']],
    ['Subgraph', ['subgraph Name\n  A --> B\nend']],
    ['Style', ['style A fill:#f96,stroke:#333']]
  ],
  sequence: [
    ['Arrows', ['A->>B: message', 'A-->>B: reply', 'A-)B: async', 'A-xB: lost']],
    ['Lifeline', ['A->>+B: start', 'B-->>-A: done']],
    ['Notes', ['Note right of A: text', 'Note over A,B: text']],
    ['Blocks', ['loop Every day\n  A->>B: msg\nend', 'alt success\n  A->>B: ok\nelse failure\n  A->>B: err\nend', 'opt Maybe\n  A->>B: msg\nend', 'par Together\n  A->>B: one\nand\n  A->>C: two\nend']],
    ['Misc', ['autonumber', 'participant A as Alias']]
  ],
  class: [
    ['Relations', ['Animal <|-- Dog', 'Car *-- Engine', 'Team o-- Player', 'A --> B', 'A ..> B']],
    ['Members', ['+String name', '-int count', '#helper()', '+doThing(arg) Type']],
    ['Class', ['class Foo {\n  +String bar\n  +baz()\n}', '<<interface>> Foo']]
  ],
  state: [
    ['Start / end', ['[*] --> Idle', 'Done --> [*]']],
    ['Transition', ['A --> B : event']],
    ['Nested', ['state Composite {\n  [*] --> Inner\n}']],
    ['Choice', ['state c <<choice>>']],
    ['Note', ['note right of A : text']]
  ],
  er: [
    ['One–one', ['A ||--|| B : relates']],
    ['One–many', ['A ||--o{ B : has']],
    ['Many–many', ['A }o--o{ B : links']],
    ['Attributes', ['USER {\n  int id\n  string name\n}']]
  ],
  gantt: [
    ['Setup', ['dateFormat YYYY-MM-DD', 'axisFormat %d %b', 'section Name']],
    ['Task', ['Task name :t1, 2026-09-01, 7d', 'Next task :after t1, 5d']],
    ['Flags', ['Done :done, d1, 2026-09-01, 3d', 'Urgent :crit, c1, 2026-09-01, 2d', 'Release :milestone, m1, 2026-09-05, 0d']]
  ],
  pie: [
    ['Setup', ['pie title My chart', 'showData']],
    ['Slice', ['"Label" : 42']]
  ],
  mindmap: [
    ['Root', ['root((Central idea))']],
    ['Branch of root', [{ rootChild: true, text: 'New branch' }]],
    ['Child (one level deeper)', ['  Child']],
    ['Shapes (as child)', ['  (rounded)', '  [square]', '  ((circle))']]
  ],
  timeline: [
    ['Setup', ['title My timeline', 'section Name']],
    ['Entry', ['2026 : event', '2026 : first : second']]
  ],
  git: [
    ['Commits', ['commit', 'commit id:"msg" tag:"v1"']],
    ['Branching', ['branch feature', 'checkout main', 'merge feature', 'cherry-pick id:"x"']]
  ]
};

function mermaidType(code) {
  const first = (code.trim().split(/\s/)[0] || '').toLowerCase();
  if (first.startsWith('flowchart') || first.startsWith('graph')) return 'flowchart';
  if (first.startsWith('sequencediagram')) return 'sequence';
  if (first.startsWith('classdiagram')) return 'class';
  if (first.startsWith('statediagram')) return 'state';
  if (first.startsWith('erdiagram')) return 'er';
  if (first.startsWith('gantt')) return 'gantt';
  if (first.startsWith('pie')) return 'pie';
  if (first.startsWith('mindmap')) return 'mindmap';
  if (first.startsWith('timeline')) return 'timeline';
  if (first.startsWith('gitgraph')) return 'git';
  return null;
}

let mmOnSave = null;
let mmRenderSeq = 0;
let mmDebounce = null;

let mmCheatType = null;

function mmUpdateCheat() {
  const type = mermaidType($('mmCode').value);
  if (type === mmCheatType && $('mmCheatBody').childElementCount) return;
  mmCheatType = type;
  $('mmCheatTitle').textContent = type ? `${type} syntax — click to insert` : 'Syntax';
  const body = $('mmCheatBody');
  if (!type) {
    body.innerHTML = '<div class="cheat-plain">Start with a diagram type (or pick a template):<br>flowchart · sequenceDiagram · classDiagram · stateDiagram-v2 · erDiagram · gantt · pie · mindmap · timeline · gitGraph</div>';
    return;
  }
  body.innerHTML = MERMAID_CHEATS[type]
    .map(
      ([label, snippets], r) =>
        `<div class="cheat-row"><span class="cheat-label">${escapeHtml(label)}</span>` +
        snippets
          .map((s, i) => {
            const text = typeof s === 'string' ? s : s.text;
            const lines = text.split('\n');
            const display = lines.length > 1 ? lines[0] + ' …' : text;
            return `<button class="cheat-chip" data-r="${r}" data-i="${i}" title="Insert at cursor">${escapeHtml(display.trim())}</button>`;
          })
          .join('') +
        '</div>'
    )
    .join('');
}

// Insert a snippet matching the indentation where the cursor sits — mermaid
// (mindmaps especially) is indentation-sensitive. Snippet-internal leading
// spaces are treated as depth relative to the current line.
function insertCheatSnippet(snippet) {
  const box = $('mmCode');
  const pos = box.selectionStart;
  const value = box.value;
  const lineStart = value.lastIndexOf('\n', pos - 1) + 1;
  const beforeInLine = value.slice(lineStart, pos);

  let base;
  let prefix;
  if (beforeInLine.trim() === '') {
    // On a blank line (or inside its indent): inherit the previous
    // non-empty line's indentation, honouring any spaces already typed.
    let inherited = '';
    let end = lineStart - 1;
    while (end > 0) {
      const start = value.lastIndexOf('\n', end - 1) + 1;
      const line = value.slice(start, end);
      if (line.trim()) {
        inherited = line.match(/^[ \t]*/)[0];
        break;
      }
      end = start - 1;
    }
    if (beforeInLine.length >= inherited.length) {
      base = beforeInLine;
      prefix = '';
    } else {
      base = inherited;
      prefix = inherited.slice(beforeInLine.length);
    }
  } else {
    // Mid-line: continue on a fresh line at this line's depth.
    base = beforeInLine.match(/^[ \t]*/)[0];
    prefix = '\n' + base;
  }

  const lines = snippet.split('\n');
  const text = prefix + lines.map((l, i) => (i === 0 ? l : base + l)).join('\n');
  box.focus();
  box.setSelectionRange(pos, box.selectionEnd);
  document.execCommand('insertText', false, text);
  clearTimeout(mmDebounce);
  mmDebounce = setTimeout(mmRender, 250);
}

// Keep the code pane's caret when clicking chips.
$('mmCheatBody').addEventListener('mousedown', (e) => e.preventDefault());
$('mmCheatBody').addEventListener('click', (e) => {
  const chip = e.target.closest('.cheat-chip');
  if (!chip || !mmCheatType) return;
  const entry = MERMAID_CHEATS[mmCheatType][Number(chip.dataset.r)][1][Number(chip.dataset.i)];
  if (typeof entry === 'object' && entry.rootChild) insertRootChild(entry.text);
  else insertCheatSnippet(entry);
});

// Insert on the line below the cursor at root depth + one level — a direct
// child of the mindmap's root, regardless of how deep the cursor sits.
function insertRootChild(text) {
  const box = $('mmCode');
  const value = box.value;
  let rootIndent = null;
  let started = false;
  for (const line of value.split('\n')) {
    if (!started) {
      if (line.trim().toLowerCase().startsWith('mindmap')) started = true;
      continue;
    }
    if (line.trim()) {
      rootIndent = line.match(/^[ \t]*/)[0];
      break;
    }
  }
  if (rootIndent === null) rootIndent = '';
  let lineEnd = value.indexOf('\n', box.selectionStart);
  if (lineEnd === -1) lineEnd = value.length;
  box.focus();
  box.setSelectionRange(lineEnd, lineEnd);
  document.execCommand('insertText', false, '\n' + rootIndent + '  ' + text);
  clearTimeout(mmDebounce);
  mmDebounce = setTimeout(mmRender, 250);
}

async function mmRender() {
  const code = $('mmCode').value.trim();
  mmUpdateCheat();
  if (!code) {
    $('mmPreview').innerHTML = '';
    $('mmError').hidden = true;
    return;
  }
  const seq = ++mmRenderSeq;
  try {
    const { svg } = await mermaid.render('mmprev' + seq, code.replaceAll('"@attachment/', '"/attachments/'));
    if (seq !== mmRenderSeq) return;
    $('mmPreview').innerHTML = svg;
    $('mmError').hidden = true;
  } catch (err) {
    if (seq !== mmRenderSeq) return;
    // Keep the last good render visible; just surface the parse error.
    $('mmError').textContent = String(err.message || err).split('\n').slice(0, 4).join('\n');
    $('mmError').hidden = false;
  }
}

function openMermaid(code, saveLabel, onSave) {
  mmOnSave = onSave;
  $('mmSave').textContent = saveLabel;
  $('mmModal').hidden = false;
  $('mmTemplate').value = '';
  $('mmCode').value = code;
  mmRender();
  $('mmCode').focus();
}

function closeMermaid() {
  mmOnSave = null;
  $('mmModal').hidden = true;
  if (state.editing) ed.focus();
}

$('mmCancel').addEventListener('click', closeMermaid);
$('mmModal').addEventListener('mousedown', (e) => {
  if (e.target === $('mmModal')) closeMermaid();
});

$('mmSave').addEventListener('click', () => {
  const code = $('mmCode').value.replace(/\s+$/, '');
  if (!code || !mmOnSave) return closeMermaid();
  const cb = mmOnSave;
  closeMermaid();
  cb(code);
});

$('mmTemplate').addEventListener('change', (e) => {
  const tpl = MERMAID_TEMPLATES[e.target.value];
  e.target.value = '';
  if (!tpl) return;
  const box = $('mmCode');
  box.focus();
  // execCommand keeps the template swap undoable with ⌘Z.
  box.setSelectionRange(0, box.value.length);
  document.execCommand('insertText', false, tpl);
  mmRender();
});

$('mmCode').addEventListener('input', () => {
  clearTimeout(mmDebounce);
  mmDebounce = setTimeout(mmRender, 250);
});

$('mmCode').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeMermaid();
  } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    $('mmSave').click();
  } else if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    e.target.setRangeText('  ', e.target.selectionStart, e.target.selectionEnd, 'end');
  }
});

const MM_FENCE = /```mermaid\n([\s\S]*?)```/g;

// The mermaid fence surrounding the editor cursor, if any.
function fenceAtCursor(box = ed) {
  const pos = box.selectionStart;
  for (const m of box.value.matchAll(MM_FENCE)) {
    if (pos >= m.index && pos <= m.index + m[0].length) {
      const start = m.index + '```mermaid\n'.length;
      return { start, end: start + m[1].length, code: m[1].replace(/\s+$/, '') };
    }
  }
  return null;
}

// Edit a rendered diagram in view mode: replace the idx-th fence and save the note.
async function editRenderedDiagram(idx) {
  const raw = await api.raw(state.current.file);
  const fence = [...raw.matchAll(MM_FENCE)][idx];
  if (!fence) return;
  openMermaid(fence[1].replace(/\s+$/, ''), 'Save', async (code) => {
    const newRaw =
      raw.slice(0, fence.index) + '```mermaid\n' + code + '\n```' + raw.slice(fence.index + fence[0].length);
    const updated = await api.save(state.current.file, newRaw);
    const scroll = $('noteView').closest('.main').scrollTop;
    applySaved(updated);
    renderMarkdown($('rendered'), updated.body);
    $('noteDate').textContent = formatDate(updated.modified);
    $('noteView').closest('.main').scrollTop = scroll;
  });
}

$('rendered').addEventListener('click', (e) => {
  const btn = e.target.closest('.diagram-edit');
  if (btn) editRenderedDiagram(Number(btn.dataset.index));
});

/* ——— presentations ——— */

let deck = null;
let deckAudio = null;
let musicPlaying = false;

// Split the note body into slides on standalone --- lines (outside code fences).
function splitSlides(body) {
  const slides = [];
  let cur = [];
  let inFence = false;
  for (const line of body.split('\n')) {
    if (/^```/.test(line.trim())) inFence = !inFence;
    if (!inFence && /^-{3,}\s*$/.test(line)) {
      slides.push(cur.join('\n'));
      cur = [];
    } else {
      cur.push(line);
    }
  }
  slides.push(cur.join('\n'));
  const nonEmpty = slides.filter((s) => s.trim());
  return nonEmpty.length ? nonEmpty : [body];
}

function playSlideSound(slideEl) {
  if (deckAudio) {
    deckAudio.pause();
    deckAudio = null;
  }
  const src = slideEl && slideEl.dataset.sound;
  if (src) {
    deckAudio = new Audio(src);
    deckAudio.play().catch(() => {});
  }
}

function musicCommand(func) {
  const iframe = $('presentMusic').querySelector('iframe');
  if (!iframe) return;
  iframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args: '' }), '*');
}

// "?t=1599", "&t=26m39s", "#t=1h2m" — YouTube start-time forms, in seconds.
function ytStartSeconds(url) {
  const m = url.match(/[?&#](?:t|start)=([0-9hms]+)/);
  if (!m) return 0;
  const v = m[1];
  if (/^\d+$/.test(v)) return +v;
  let s = 0;
  const h = v.match(/(\d+)h/);
  const min = v.match(/(\d+)m/);
  const sec = v.match(/(\d+)s/);
  if (h) s += +h[1] * 3600;
  if (min) s += +min[1] * 60;
  if (sec) s += +sec[1];
  return s;
}

// Deck music: the directive's slide decides when playback begins.
let presMusic = null;

function startPresentationMusic() {
  if (!presMusic || presMusic.started) return;
  const id = youtubeId(presMusic.url);
  if (!id) return;
  presMusic.started = true;
  const t = ytStartSeconds(presMusic.url);
  $('presentMusic').innerHTML =
    `<iframe src="https://www.youtube-nocookie.com/embed/${id}?autoplay=1&loop=1&playlist=${id}${t ? '&start=' + t : ''}&enablejsapi=1" allow="autoplay; encrypted-media" title="Background music"></iframe>`;
  musicPlaying = true;
  $('musicToggle').hidden = false;
  $('musicToggle').classList.remove('muted');
}

async function openPresentation() {
  const note = state.current;
  if (!note || deck) return;
  // Present what you see: save pending editor changes first.
  if (state.editing && state.dirty) {
    const updated = await api.save(note.file, await rawForSave($('editor').value));
    applySaved(updated);
  }
  const body = state.current.body;
  const musicUrl = (body.match(/<!--\s*music:\s*(\S+)\s*-->/) || [])[1] || null;

  $('presentView').hidden = false;
  const slidesEl = $('presentSlides');
  slidesEl.innerHTML = '';
  const chunks = splitSlides(expandTransclusions(body));
  // Slide 1's transition directive is the deck default; on later slides the
  // directive overrides for that slide only (reveal's data-transition).
  const transition = (chunks[0].match(/<!--\s*transition:\s*([\w-]+)\s*-->/) || [])[1] || 'slide';
  presMusic = null;
  for (const [i, chunk] of chunks.entries()) {
    const sec = document.createElement('section');
    slidesEl.appendChild(sec);
    renderMarkdown(sec, chunk, { staticMermaid: true });
    sec.querySelectorAll('.transcribe-btn, .diagram-edit').forEach((b) => b.remove());
    await renderMermaidStatic(sec);
    if (/<!--\s*steps\s*-->/.test(chunk)) {
      sec.querySelectorAll(':scope > ul > li, :scope > ol > li').forEach((li) => li.classList.add('fragment'));
    }
    const sound = (chunk.match(/<!--\s*sound:\s*(\S+)\s*-->/) || [])[1];
    if (sound) sec.dataset.sound = sound.replace('@attachment/', '/attachments/');
    if (i > 0) {
      const own = (chunk.match(/<!--\s*transition:\s*([\w-]+)\s*-->/) || [])[1];
      if (own) sec.dataset.transition = own;
    }
    const bg = (chunk.match(/<!--\s*background:\s*(\S+)\s*-->/) || [])[1];
    if (bg) sec.setAttribute('data-background-color', bg);
    const fg = (chunk.match(/<!--\s*color:\s*(\S+)\s*-->/) || [])[1];
    if (fg) {
      sec.style.color = fg;
      sec.classList.add('slide-fg');
    }
    // Music begins on the slide that carries the directive.
    if (!presMusic && /<!--\s*music:/.test(chunk) && musicUrl) {
      presMusic = { url: musicUrl, startAt: i, started: false };
    }
  }

  deck = new Reveal($('presentRoot'), {
    embedded: true,
    transition,
    hash: false,
    controls: true,
    progress: true,
    center: true,
    // Slides carry clickable media and transcript folds — keep the cursor.
    hideInactiveCursor: false,
    keyboard: {
      27: null, // Esc is ours — exits the presentation
      32: () => {
        // Space toggles the current slide's media; advances otherwise.
        const slide = deck.getCurrentSlide();
        const media = slide.querySelector('video, audio') ||
          (slide.dataset.sound && deckAudio ? deckAudio : null);
        if (media) {
          if (media.paused) media.play().catch(() => {});
          else media.pause();
        } else {
          deck.next();
        }
      }
    }
  });
  await deck.initialize();
  deck.on('slidechanged', (e) => {
    playSlideSound(e.currentSlide);
    if (presMusic && !presMusic.started && deck.getIndices().h >= presMusic.startAt) {
      startPresentationMusic();
    }
  });
  playSlideSound(deck.getCurrentSlide());
  if (presMusic && presMusic.startAt === 0) startPresentationMusic();
}

function closePresentation() {
  if (!deck) return;
  try { deck.destroy(); } catch (e) { /* reveal already gone */ }
  deck = null;
  playSlideSound(null);
  presMusic = null;
  $('presentMusic').innerHTML = '';
  $('musicToggle').hidden = true;
  $('presentSlides').innerHTML = '';
  $('presentView').hidden = true;
}

/* ——— presentation editor: slide rail ——— */

// Index just past the closing --- of the front matter block in raw text.
function frontmatterEndIndex(raw) {
  if (!raw.startsWith('---')) return 0;
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return 0;
  const nl = raw.indexOf('\n', end + 1 + 3);
  return nl === -1 ? raw.length : nl + 1;
}

// Slide ranges [{start, end}] in the editor's raw text (front matter excluded).
function computeSlideRanges(raw) {
  const fmEnd = frontmatterEndIndex(raw);
  const ranges = [];
  let start = fmEnd;
  let inFence = false;
  let pos = fmEnd;
  for (const line of raw.slice(fmEnd).split('\n')) {
    if (/^```/.test(line.trim())) inFence = !inFence;
    if (!inFence && /^-{3,}\s*$/.test(line)) {
      ranges.push({ start, end: pos });
      start = pos + line.length + 1;
    }
    pos += line.length + 1;
  }
  ranges.push({ start, end: raw.length });
  return ranges;
}

function isDeckNote(note) {
  return (
    note.tags.includes('Presentation') ||
    splitSlides(note.body).length > 1 ||
    /<!--\s*(transition|music|steps|sound)\b/.test(note.body)
  );
}

function slideThumbHtml(chunk) {
  const cleaned = chunk
    .replace(/```mermaid[\s\S]*?(```|$)/g, '\n<div class="thumb-diagram">◇ diagram</div>\n')
    .replace(/```[\s\S]*?(```|$)/g, '\n<div class="thumb-diagram">‹/› code</div>\n');
  try {
    return marked.parse(preprocess(cleaned), { gfm: true, breaks: true });
  } catch (e) {
    return escapeHtml(chunk);
  }
}

/* ——— deck editor modal ——— */

const deckEd = { open: false, file: null, fm: '', slides: [], cur: 0, dirty: false };
let deckPreviewTimer = null;
let deckThumbTimer = null;

const dcEl = () => $('deckCode');

// Undo-friendly replace in the deck slide textarea.
function dcReplace(from, to, text) {
  const box = dcEl();
  box.focus();
  box.setSelectionRange(from, to);
  if (text) document.execCommand('insertText', false, text);
  else document.execCommand('delete');
  deckEd.dirty = true;
}

function deckSerialize() {
  return deckEd.fm + '\n' + deckEd.slides.map((s) => s.trim()).join('\n\n---\n\n') + '\n';
}

function deckCommitCurrent() {
  if (deckEd.slides.length) deckEd.slides[deckEd.cur] = dcEl().value;
}

function renderDeckThumbs() {
  $('deckThumbs').innerHTML = deckEd.slides
    .map((chunk, i) => {
      const c = chunk.trim();
      const bg = (c.match(/<!--\s*background:\s*(\S+)\s*-->/) || [])[1];
      const fg = (c.match(/<!--\s*color:\s*(\S+)\s*-->/) || [])[1];
      const tint = `${bg ? `background:${bg};` : ''}${fg ? `color:${fg};` : ''}`;
      return `<div class="slide-thumb${i === deckEd.cur ? ' active' : ''}" data-i="${i}" title="Slide ${i + 1}"${tint ? ` style="${tint}"` : ''}>
        <div class="thumb-canvas"${fg ? ` style="color:${fg}"` : ''}>${c ? slideThumbHtml(c) : '<p class="thumb-empty">(empty)</p>'}</div>
        <span class="thumb-num">${i + 1}</span>
        <span class="thumb-tools">
          <button data-move="up" data-i="${i}" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button data-move="down" data-i="${i}" title="Move down" ${i === deckEd.slides.length - 1 ? 'disabled' : ''}>↓</button>
          <button data-del="${i}" title="Delete slide" ${deckEd.slides.length === 1 ? 'disabled' : ''}>×</button>
        </span>
      </div>`;
    })
    .join('');
}

async function renderDeckPreview() {
  const box = $('deckPreview');
  const chunk = dcEl().value.trim();
  if (!chunk) {
    box.innerHTML = '<p class="thumb-empty">(empty slide)</p>';
    return;
  }
  renderMarkdown(box, chunk, { staticMermaid: true });
  box.querySelectorAll('.transcribe-btn, .diagram-edit').forEach((b) => b.remove());
  const bg = (chunk.match(/<!--\s*background:\s*(\S+)\s*-->/) || [])[1];
  box.style.backgroundColor = bg || '';
  const fg = (chunk.match(/<!--\s*color:\s*(\S+)\s*-->/) || [])[1];
  box.style.color = fg || '';
  await renderMermaidStatic(box);
}

function scheduleDeckPreview() {
  clearTimeout(deckPreviewTimer);
  deckPreviewTimer = setTimeout(renderDeckPreview, 300);
  clearTimeout(deckThumbTimer);
  deckThumbTimer = setTimeout(() => {
    deckCommitCurrent();
    renderDeckThumbs();
  }, 700);
}

function deckLoadSlide(i) {
  deckCommitCurrent();
  deckEd.cur = Math.max(0, Math.min(i, deckEd.slides.length - 1));
  dcEl().value = deckEd.slides[deckEd.cur];
  renderDeckThumbs();
  renderDeckPreview();
  syncSlideTransitionSelect();
  syncSlideBg();
  syncSlideFg();
  document.querySelector('#deckThumbs .slide-thumb.active')?.scrollIntoView({ block: 'nearest' });
}

async function openDeckEditor() {
  const note = state.current;
  if (!note) return;
  if (state.editing) await exitEdit({ save: true });
  const raw = await api.raw(note.file);
  const fmEnd = frontmatterEndIndex(raw);
  deckEd.file = note.file;
  deckEd.fm = raw.slice(0, fmEnd);
  const bodyPart = raw.slice(fmEnd);
  deckEd.slides = splitSlides(bodyPart).map((s) => s.trim());
  if (!deckEd.slides.length) deckEd.slides = ['# ' + note.title];
  deckEd.cur = 0;
  deckEd.dirty = false;
  deckEd.open = true;
  const tr = (deckEd.slides[0].match(/<!--\s*transition:\s*([\w-]+)\s*-->/) || [])[1] || '';
  $('deckTransition').value = ['slide', 'fade', 'zoom', 'convex', 'concave', 'none'].includes(tr) ? tr : '';
  syncSlideTransitionSelect();
  syncSlideBg();
  syncSlideFg();
  $('deckModal').hidden = false;
  // Borrow the main editor's toolbar — same buttons, same listeners,
  // retargeted at the slide pane.
  $('deckToolbarSlot').appendChild($('editorToolbar'));
  tbBox = dcEl();
  applyDeckTbCollapsed();
  dcEl().value = deckEd.slides[0];
  renderDeckThumbs();
  renderDeckPreview();
  dcEl().focus();
}

function applyDeckTbCollapsed() {
  let collapsed = false;
  try { collapsed = localStorage.getItem('deckTbCollapsed') === '1'; } catch (e) { /* private mode */ }
  $('editorToolbar').classList.toggle('tb-collapsed', collapsed && deckEd.open);
  $('deckTbToggle').textContent = collapsed ? '+' : '–';
}

$('deckTbToggle').addEventListener('click', () => {
  try {
    const collapsed = localStorage.getItem('deckTbCollapsed') === '1';
    localStorage.setItem('deckTbCollapsed', collapsed ? '0' : '1');
  } catch (e) { /* private mode */ }
  applyDeckTbCollapsed();
});

async function saveDeck() {
  deckCommitCurrent();
  const updated = await api.save(deckEd.file, deckSerialize());
  applySaved(updated);
  deckEd.dirty = false;
  if (state.current && state.current.file === updated.file && !state.editing) {
    renderMarkdown($('rendered'), updated.body);
    renderBacklinks(updated);
    $('noteDate').textContent = formatDate(updated.modified);
  }
  return updated;
}

async function closeDeckEditor() {
  closeSuggest();
  closeEmoji();
  await saveDeck();
  deckEd.open = false;
  $('deckModal').hidden = true;
  // Return the toolbar to the main editor.
  $('editorToolbar').classList.remove('tb-collapsed');
  $('editorWrap').insertBefore($('editorToolbar'), $('editor'));
  tbBox = null;
}

$('deckBtn').addEventListener('click', openDeckEditor);
$('deckDone').addEventListener('click', closeDeckEditor);

$('deckPresentBtn').addEventListener('click', async () => {
  await saveDeck();
  openPresentation();
});

$('deckThumbs').addEventListener('click', (e) => {
  const move = e.target.closest('[data-move]');
  const del = e.target.closest('[data-del]');
  if (move) {
    const i = Number(move.dataset.i);
    const j = i + (move.dataset.move === 'up' ? -1 : 1);
    if (j < 0 || j >= deckEd.slides.length) return;
    deckCommitCurrent();
    [deckEd.slides[i], deckEd.slides[j]] = [deckEd.slides[j], deckEd.slides[i]];
    deckEd.dirty = true;
    if (deckEd.cur === i) deckEd.cur = j;
    else if (deckEd.cur === j) deckEd.cur = i;
    dcEl().value = deckEd.slides[deckEd.cur];
    renderDeckThumbs();
    renderDeckPreview();
    return;
  }
  if (del) {
    if (deckEd.slides.length === 1) return;
    if (!del.classList.contains('confirming')) {
      del.classList.add('confirming');
      setTimeout(() => del.classList.remove('confirming'), 2500);
      return;
    }
    const i = Number(del.dataset.del);
    deckEd.slides.splice(i, 1);
    deckEd.dirty = true;
    deckEd.cur = Math.min(deckEd.cur, deckEd.slides.length - 1);
    dcEl().value = deckEd.slides[deckEd.cur];
    renderDeckThumbs();
    renderDeckPreview();
    return;
  }
  const thumb = e.target.closest('.slide-thumb');
  if (thumb) deckLoadSlide(Number(thumb.dataset.i));
});

$('deckAddSlide').addEventListener('click', () => {
  deckCommitCurrent();
  deckEd.slides.splice(deckEd.cur + 1, 0, '## New slide\n');
  deckEd.dirty = true;
  deckLoadSlide(deckEd.cur + 1);
});

// Deck default lives on slide 1; per-slide overrides stay untouched.
$('deckTransition').addEventListener('change', (e) => {
  const t = e.target.value;
  deckCommitCurrent();
  deckEd.slides[0] = deckEd.slides[0].replace(/<!--\s*transition:[^>]*-->\n*/g, '').trim();
  if (t) deckEd.slides[0] = `<!-- transition: ${t} -->\n\n` + deckEd.slides[0];
  deckEd.dirty = true;
  dcEl().value = deckEd.slides[deckEd.cur];
  renderDeckThumbs();
  renderDeckPreview();
});

function syncSlideTransitionSelect() {
  const sel = $('slideTransition');
  if (deckEd.cur === 0) {
    sel.value = '';
    sel.disabled = true;
    sel.title = 'Slide 1 carries the deck default — use the header select';
  } else {
    sel.disabled = false;
    sel.title = 'Transition for this slide only';
    const tr = (deckEd.slides[deckEd.cur].match(/<!--\s*transition:\s*([\w-]+)\s*-->/) || [])[1] || '';
    sel.value = ['slide', 'fade', 'zoom', 'convex', 'concave', 'none'].includes(tr) ? tr : '';
  }
}

$('slideTransition').addEventListener('change', (e) => {
  if (deckEd.cur === 0) return;
  deckCommitCurrent();
  let s = deckEd.slides[deckEd.cur].replace(/<!--\s*transition:[^>]*-->\n*/g, '').trim();
  if (e.target.value) s = `<!-- transition: ${e.target.value} -->\n\n` + s;
  deckEd.slides[deckEd.cur] = s;
  deckEd.dirty = true;
  dcEl().value = s;
  renderDeckThumbs();
  renderDeckPreview();
});

function syncSlideBg() {
  const bg = (deckEd.slides[deckEd.cur].match(/<!--\s*background:\s*(\S+)\s*-->/) || [])[1];
  const swatch = $('slideBgSwatch');
  swatch.style.background = bg || 'transparent';
  swatch.classList.toggle('bg-none', !bg);
}

function setSlideBackground(color) {
  deckCommitCurrent();
  let s = deckEd.slides[deckEd.cur].replace(/<!--\s*background:[^>]*-->\n*/g, '').trim();
  if (color) s = `<!-- background: ${color} -->\n\n` + s;
  deckEd.slides[deckEd.cur] = s;
  deckEd.dirty = true;
  dcEl().value = s;
  renderDeckThumbs();
  renderDeckPreview();
  syncSlideBg();
}

function setSlideTextColor(color) {
  deckCommitCurrent();
  let s = deckEd.slides[deckEd.cur].replace(/<!--\s*color:[^>]*-->\n*/g, '').trim();
  if (color) s = `<!-- color: ${color} -->\n\n` + s;
  deckEd.slides[deckEd.cur] = s;
  deckEd.dirty = true;
  dcEl().value = s;
  renderDeckThumbs();
  renderDeckPreview();
  syncSlideFg();
}

function syncSlideFg() {
  const fg = (deckEd.slides[deckEd.cur].match(/<!--\s*color:\s*(\S+)\s*-->/) || [])[1];
  const swatch = $('slideFgSwatch');
  swatch.style.background = fg || 'transparent';
  swatch.classList.toggle('bg-none', !fg);
}

$('slideBgBtn').addEventListener('click', () => {
  $('colorPanel').hidden || colorMode !== 'bg'
    ? openColorPanelFor('bg', $('slideBgBtn'))
    : closeColorPanel();
});
$('slideFgBtn').addEventListener('click', () => {
  $('colorPanel').hidden || colorMode !== 'fg'
    ? openColorPanelFor('fg', $('slideFgBtn'))
    : closeColorPanel();
});

$('deckMusic').addEventListener('click', () => {
  const box = dcEl();
  const tpl = '<!-- music: https://www.youtube.com/watch?v=VIDEO_ID -->\n';
  dcReplace(0, 0, tpl);
  const s = tpl.indexOf('https://');
  box.setSelectionRange(s, tpl.length - ' -->\n'.length);
  scheduleDeckPreview();
});

const deckToolbar = {
  steps: () => {
    const v = dcEl().value;
    if (/<!--\s*steps\s*-->/.test(v)) {
      const m = v.match(/<!--\s*steps\s*-->\n?/);
      dcReplace(m.index, m.index + m[0].length, '');
    } else {
      dcReplace(0, 0, '<!-- steps -->\n\n');
    }
  },
  sound: () => {
    const tpl = '<!-- sound: @attachment/file.mp3 -->\n';
    dcReplace(0, 0, tpl);
    const s = tpl.indexOf('@attachment/');
    dcEl().setSelectionRange(s, s + '@attachment/file.mp3'.length);
  },
  embed: () => {
    const box = dcEl();
    const s = box.selectionStart;
    dcReplace(s, box.selectionEnd, '![[]]');
    box.setSelectionRange(s + 3, s + 3);
    // Cursor sits between the brackets — pop the note dropdown right away.
    updateSuggest(box);
  }
};

document.querySelector('.deck-toolbar').addEventListener('mousedown', (e) => {
  // Keep the slide pane's caret — except controls that need real focus:
  // inputs (emoji search, color pickers) and <select> dropdowns.
  if (!e.target.closest('input, select')) e.preventDefault();
});
document.querySelector('.deck-toolbar').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-dk]');
  if (btn && deckToolbar[btn.dataset.dk]) {
    deckToolbar[btn.dataset.dk]();
    scheduleDeckPreview();
  }
});

dcEl().addEventListener('input', () => {
  deckEd.dirty = true;
  scheduleDeckPreview();
  updateSuggest(dcEl());
});
dcEl().addEventListener('click', () => updateSuggest(dcEl()));
dcEl().addEventListener('blur', closeSuggest);
dcEl().addEventListener('scroll', closeSuggest);
dcEl().addEventListener('keydown', (e) => {
  if (handleSuggestKeys(e)) return;
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    saveDeck();
  } else if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    dcReplace(dcEl().selectionStart, dcEl().selectionEnd, '  ');
  }
});

// Present is screen-aware in the desktop app: with an external display
// connected it opens presenter mode (deck on the TV, notes here); on a single
// screen it presents in-app as always. ⋯ → "Presenter mode" forces the
// presenter flow regardless.
$('presentBtn').addEventListener('click', async () => {
  const native = window.marknoteNative;
  if (native) {
    try {
      const displays = await native.displays();
      if (displays.length > 1) return openPresenterMode();
    } catch (e) { /* fall through to in-app presenting */ }
  }
  openPresentation();
});
$('presentClose').addEventListener('click', closePresentation);
$('musicToggle').addEventListener('click', () => {
  musicPlaying = !musicPlaying;
  musicCommand(musicPlaying ? 'playVideo' : 'pauseVideo');
  $('musicToggle').classList.toggle('muted', !musicPlaying);
});

/* ——— meeting recording ——— */

const rec = {
  recorder: null, chunks: [], paused: false,
  accMs: 0, segStart: 0, ctx: null, analyser: null, wave: [], raf: 0
};

function alertBar(msg) {
  const el = $('saveState');
  el.textContent = msg;
  el.classList.remove('dirty');
  setTimeout(() => { if (!state.dirty) el.textContent = ''; }, 6000);
}

function recElapsed() {
  return rec.accMs + (rec.recorder && !rec.paused ? Date.now() - rec.segStart : 0);
}

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m >= 60
    ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
    : `${m}:${String(s % 60).padStart(2, '0')}`;
}

function openMeetingView() {
  $('empty').hidden = true;
  $('noteView').hidden = true;
  $('trashView').hidden = true;
  $('todoView').hidden = true;
  $('meetingView').hidden = false;
  closeFind();
  document.title = 'Meeting — Marknote';
}

function closeMeetingView() {
  $('meetingView').hidden = true;
  if (state.current) {
    $('noteView').hidden = false;
    document.title = state.current.title + ' — Marknote';
  } else {
    $('empty').hidden = false;
    document.title = 'Marknote';
  }
}

async function startMeeting() {
  if (rec.recorder) {
    openMeetingView();
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    alertBar(`Microphone unavailable: ${err.name === 'NotAllowedError' ? 'permission denied — allow the mic in System Settings → Privacy' : err.message}`);
    return;
  }
  const pd = (n) => String(n).padStart(2, '0');
  const t0 = new Date();
  rec.fileStamp = `${t0.getFullYear()}-${pd(t0.getMonth() + 1)}-${pd(t0.getDate())}-${pd(t0.getHours())}-${pd(t0.getMinutes())}`;
  rec.partName = `Meeting-${rec.fileStamp}.weba.part`;
  rec.streamQ = Promise.resolve();
  rec.streamOk = true;
  rec.chunks = [];
  rec.recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
  rec.recorder.ondataavailable = (e) => {
    if (!e.data.size) return;
    rec.chunks.push(e.data);
    // Crash safety: mirror every chunk to disk while recording. If this
    // ever fails we stop mirroring but keep recording in memory.
    if (rec.streamOk) {
      const part = rec.partName;
      const blob = e.data;
      rec.streamQ = rec.streamQ
        .then(() => fetch('/api/rec-chunk?name=' + encodeURIComponent(part), { method: 'POST', body: blob }))
        .then((r) => { if (!r.ok) rec.streamOk = false; })
        .catch(() => { rec.streamOk = false; });
    }
  };
  rec.recorder.start(5000);
  rec.paused = false;
  rec.accMs = 0;
  rec.segStart = Date.now();
  rec.nextRemindMs = 60 * 60 * 1000;
  rec.wave = [];
  rec.ctx = new AudioContext();
  rec.analyser = rec.ctx.createAnalyser();
  rec.analyser.fftSize = 512;
  rec.ctx.createMediaStreamSource(stream).connect(rec.analyser);

  const p = (n) => String(n).padStart(2, '0');
  const now = new Date();
  $('meetingTitle').value =
    `Meeting ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;
  $('meetingNotes').value = '';
  $('meetPause').textContent = 'Pause';
  $('meetingStatus').textContent = 'Recording';
  $('recBarState').textContent = 'Recording…';
  $('recBar').hidden = false;
  openMeetingView();
  $('meetingNotes').focus();
  rec.timerInt = setInterval(updateMeetingTimers, 500);
  meetingTick();
}

// Timer via setInterval (keeps ticking in background windows); the waveform
// runs on requestAnimationFrame and simply pauses while not visible.
function updateMeetingTimers() {
  if (!rec.recorder) return;
  const t = fmtElapsed(recElapsed());
  $('recTime').textContent = t;
  $('meetingTimer').textContent = t;
  // Hourly "did you forget me?" nudge — reminds, never auto-stops.
  if (!rec.paused && recElapsed() >= rec.nextRemindMs) {
    rec.nextRemindMs += 60 * 60 * 1000;
    $('recRemindText').textContent = `Still recording — ${t}. Forgot to stop?`;
    $('recRemind').hidden = false;
    try {
      new Notification('Marknote is still recording', {
        body: `The meeting recording has been running for ${t}.`
      });
    } catch (e) { /* notification not available */ }
  }
}

function meetingTick() {
  if (!rec.recorder) return;
  if (!rec.paused) {
    const data = new Uint8Array(rec.analyser.frequencyBinCount);
    rec.analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const v of data) {
      const d = (v - 128) / 128;
      sum += d * d;
    }
    rec.wave.push(Math.sqrt(sum / data.length));
    if (rec.wave.length > 240) rec.wave.shift();
  }
  if (!$('meetingView').hidden) drawMeetingWave();
  rec.raf = requestAnimationFrame(meetingTick);
}

function drawMeetingWave() {
  const canvas = $('meetingWave');
  const g = canvas.getContext('2d');
  const cs = getComputedStyle(document.body);
  const W = canvas.width;
  const H = canvas.height;
  g.clearRect(0, 0, W, H);
  g.fillStyle = (rec.paused ? cs.getPropertyValue('--ink-faint') : cs.getPropertyValue('--accent')).trim();
  const n = 240;
  const bw = W / n;
  rec.wave.forEach((v, i) => {
    const h = Math.max(2, Math.min(1, v * 3) * H);
    g.fillRect((n - rec.wave.length + i) * bw, (H - h) / 2, bw * 0.6, h);
  });
}

function togglePauseMeeting() {
  if (!rec.recorder) return;
  if (rec.paused) {
    rec.recorder.resume();
    rec.paused = false;
    rec.segStart = Date.now();
  } else {
    rec.recorder.pause();
    rec.paused = true;
    rec.accMs += Date.now() - rec.segStart;
  }
  $('meetPause').textContent = rec.paused ? 'Resume' : 'Pause';
  $('meetingStatus').textContent = rec.paused ? 'Paused' : 'Recording';
  $('recBarState').textContent = rec.paused ? 'Paused' : 'Recording…';
}

function teardownMeeting() {
  cancelAnimationFrame(rec.raf);
  clearInterval(rec.timerInt);
  if (rec.recorder) rec.recorder.stream.getTracks().forEach((t) => t.stop());
  if (rec.ctx) rec.ctx.close();
  rec.recorder = null;
  rec.chunks = [];
  rec.paused = false;
  rec.accMs = 0;
  rec.wave = [];
  $('recBar').hidden = true;
  $('recTime').textContent = '0:00';
  $('recRemind').hidden = true;
}

async function stopMeeting() {
  if (!rec.recorder) return;
  const r = rec.recorder;
  const title = $('meetingTitle').value.trim() || 'Meeting';
  const notes = $('meetingNotes').value.trim();
  const durMs = recElapsed();
  const partName = rec.partName;
  const fileStamp = rec.fileStamp;
  r.onstop = async () => {
    let blob = new Blob(rec.chunks, { type: 'audio/webm' });
    teardownMeeting();
    if (!blob.size) {
      closeMeetingView();
      alertBar('Nothing was recorded.');
      return;
    }
    try {
      // MediaRecorder webm lacks duration metadata — patch it in so players
      // show the clip length.
      if (typeof ysFixWebmDuration === 'function') {
        blob = await new Promise((res) => ysFixWebmDuration(blob, durMs, res));
      }
      const { file: audioFile } = await api.upload(blob, `Meeting-${fileStamp}.weba`);
      fetch('/api/rec-chunk?name=' + encodeURIComponent(partName), { method: 'DELETE' }).catch(() => {});
      const { file } = await api.create(title);
      let raw = await api.raw(file);
      raw = setTagsInRaw(raw, ['Meeting']);
      raw = raw.replace(/\n*$/, `\n[Recording · ${fmtElapsed(durMs)}](@attachment/${audioFile})\n`);
      if (notes) raw += `\n## Notes\n\n${notes}\n`;
      await api.save(file, raw);
      state.notes = await api.list();
      renderTags();
      renderList();
      openNote(file);
    } catch (err) {
      closeMeetingView();
      alertBar('Saving the recording failed: ' + err.message);
    }
  };
  r.stop();
}

let discardArmed = null;
function discardMeeting() {
  const btn = $('meetDiscard');
  if (!discardArmed) {
    btn.textContent = 'Really discard?';
    btn.classList.add('confirming');
    discardArmed = setTimeout(() => {
      discardArmed = null;
      btn.textContent = 'Discard';
      btn.classList.remove('confirming');
    }, 3000);
    return;
  }
  clearTimeout(discardArmed);
  discardArmed = null;
  btn.textContent = 'Discard';
  btn.classList.remove('confirming');
  const r = rec.recorder;
  const partName = rec.partName;
  if (r) {
    r.onstop = null;
    r.stop();
  }
  teardownMeeting();
  closeMeetingView();
  if (partName) {
    fetch('/api/rec-chunk?name=' + encodeURIComponent(partName), { method: 'DELETE' }).catch(() => {});
  }
}

$('recBar').addEventListener('click', openMeetingView);
$('recRemindKeep').addEventListener('click', () => { $('recRemind').hidden = true; });
$('recRemindStop').addEventListener('click', () => {
  $('recRemind').hidden = true;
  stopMeeting();
});
$('meetPause').addEventListener('click', togglePauseMeeting);
$('meetStop').addEventListener('click', stopMeeting);
$('meetDiscard').addEventListener('click', discardMeeting);

/* ——— transcription ——— */

async function transcribeAudio(src, btn) {
  const note = state.current;
  const file = decodeURIComponent((src.split('/attachments/')[1] || '').split(/[?#]/)[0]);
  if (!file) return;
  btn.disabled = true;
  const startedAt = Date.now();
  const tick = setInterval(() => {
    btn.textContent = `Transcribing… ${fmtElapsed(Date.now() - startedAt)}`;
  }, 1000);
  try {
    btn.textContent = 'Transcribing…';
    const tRes = await fetch('/api/transcribe', { method: 'POST', body: JSON.stringify({ file }) });
    clearInterval(tick);
    if (!tRes.ok) throw new Error((await tRes.json()).error);
    const { text } = await tRes.json();
    if (!text) throw new Error('empty transcript — was anything said?');

    let summary = null;
    btn.textContent = 'Summarizing with Claude…';
    try {
      const sRes = await fetch('/api/summarize', {
        method: 'POST',
        body: JSON.stringify({ text, title: note.title })
      });
      if (sRes.ok) summary = (await sRes.json()).summary;
    } catch (e) { /* transcript still gets saved */ }

    let raw = await api.raw(note.file);
    const sections =
      (summary ? `\n## Summary\n\n${summary}\n` : '') +
      `\n## Transcript\n\n<details>\n<summary>Show transcript</summary>\n\n${text}\n\n</details>\n`;
    raw = raw.replace(/\n*$/, '\n') + sections;
    const updated = await api.save(note.file, raw);
    applySaved(updated);
    renderMarkdown($('rendered'), updated.body);
    renderBacklinks(updated);
    $('noteDate').textContent = formatDate(updated.modified);
    alertBar(summary ? 'transcribed & summarized' : 'transcribed (summary unavailable)');
  } catch (err) {
    clearInterval(tick);
    btn.disabled = false;
    btn.textContent = 'Transcribe & summarize';
    alertBar('Transcription failed: ' + String(err.message).slice(0, 120));
  }
}

$('rendered').addEventListener('click', (e) => {
  const btn = e.target.closest('.transcribe-btn');
  if (btn && state.current) transcribeAudio(btn.dataset.src, btn);
});

/* ——— emoji picker ——— */

// Each entry: "emoji name keywords" — split at the first space.
const EMOJI_SETS = [
  ['Smileys', ['😀 grinning happy', '😄 smile happy', '😁 beaming grin', '😂 joy laughing tears', '🤣 rofl laughing', '😊 blush happy', '🙂 slight smile', '😉 wink', '😇 innocent halo', '🥰 love hearts', '😍 heart eyes love', '🤩 star struck wow', '😘 kiss', '😋 yum tasty', '😜 winking tongue', '🤪 zany crazy', '🤗 hug', '🤔 thinking hmm', '🤫 shush quiet', '😐 neutral', '😶 no mouth silent', '🙄 eye roll', '😏 smirk', '😴 sleeping zzz', '🤤 drooling', '😷 mask sick', '🤒 thermometer sick', '🤢 nauseated sick', '🥵 hot heat', '🥶 cold freezing', '🤯 mind blown exploding', '🥳 party celebrate', '😎 cool sunglasses', '🤓 nerd glasses', '😕 confused', '😮 open mouth wow', '😳 flushed embarrassed', '🥺 pleading puppy eyes', '😢 crying sad tear', '😭 sobbing crying', '😱 scream fear', '😤 huffing frustrated', '😡 angry mad rage', '💀 skull dead', '💩 poop', '🤡 clown', '👻 ghost', '👽 alien', '🤖 robot']],
  ['Gestures', ['👍 thumbs up yes good', '👎 thumbs down no bad', '👌 ok perfect', '✌️ victory peace', '🤞 crossed fingers luck', '🤘 rock horns', '🤙 call me shaka', '👈 point left', '👉 point right', '👆 point up', '👇 point down', '✋ raised hand stop', '👋 wave hello bye', '🤝 handshake deal', '🙏 pray thanks please', '✍️ writing', '💪 muscle strong flex', '👀 eyes looking', '🧠 brain', '🗣 speaking talk', '🙇 bow', '🤷 shrug dunno', '🤦 facepalm', '🙋 hand raised question']],
  ['Nature', ['🐶 dog puppy', '🐱 cat kitten', '🐭 mouse', '🐰 rabbit bunny', '🦊 fox', '🐻 bear', '🐼 panda', '🦁 lion', '🐷 pig', '🐸 frog', '🐵 monkey', '🐧 penguin', '🐦 bird', '🦅 eagle', '🦉 owl', '🦄 unicorn', '🐝 bee', '🦋 butterfly', '🐢 turtle', '🐍 snake', '🐙 octopus', '🦀 crab', '🐬 dolphin', '🐳 whale', '🦈 shark', '🌵 cactus', '🎄 christmas tree', '🌲 evergreen tree', '🌳 tree', '🌱 seedling plant', '☘️ shamrock', '🍀 four leaf clover luck', '🌸 cherry blossom flower', '🌻 sunflower', '🌞 sun face', '🌙 crescent moon', '⭐ star', '🌟 glowing star', '✨ sparkles', '⚡ lightning zap bolt', '🔥 fire hot lit', '🌈 rainbow', '☀️ sunny', '☁️ cloud', '🌧 rain', '❄️ snowflake snow', '💧 droplet water', '🌊 wave ocean']],
  ['Food', ['🍎 apple', '🍊 orange tangerine', '🍋 lemon', '🍌 banana', '🍉 watermelon', '🍇 grapes', '🍓 strawberry', '🍒 cherries', '🍍 pineapple', '🥥 coconut', '🥑 avocado', '🥦 broccoli', '🥕 carrot', '🌽 corn', '🌶 hot pepper spicy', '🥔 potato', '🍞 bread', '🥐 croissant', '🥨 pretzel', '🧀 cheese', '🥚 egg', '🍳 cooking fried egg', '🥞 pancakes', '🥓 bacon', '🍔 burger hamburger', '🍟 fries', '🍕 pizza', '🌭 hotdog', '🥪 sandwich', '🌮 taco', '🌯 burrito', '🥗 salad', '🍝 pasta spaghetti', '🍜 ramen noodles', '🍣 sushi', '🍤 shrimp tempura', '🍦 ice cream', '🍰 cake', '🎂 birthday cake', '🧁 cupcake', '🍭 lollipop candy', '🍫 chocolate', '🍿 popcorn', '🍩 donut', '🍪 cookie', '☕ coffee', '🍵 tea', '🍺 beer', '🥂 cheers champagne', '🍷 wine', '🍹 cocktail']],
  ['Activity', ['⚽ soccer football', '🏀 basketball', '🏈 american football', '⚾ baseball', '🎾 tennis', '🏐 volleyball', '🎱 8 ball pool billiards', '🏓 ping pong table tennis', '🏸 badminton', '🥊 boxing', '⛸ ice skate', '🎿 ski', '🏂 snowboard', '🏋️ weight lifting gym', '🤸 cartwheel gymnastics', '🧘 yoga meditation', '🏄 surfing', '🏊 swimming', '🚴 cycling bike', '🧗 climbing bouldering', '🎯 dart target bullseye', '🎳 bowling', '🎮 video game controller', '🎲 dice game', '🎪 circus', '🎭 theater drama', '🎨 art palette paint', '🎬 clapper movie film', '🎤 microphone sing', '🎧 headphones music', '🎵 music note', '🎶 music notes', '🎹 piano', '🥁 drum', '🎸 guitar', '🎻 violin', '🏆 trophy win', '🥇 gold medal first', '🥈 silver medal second', '🥉 bronze medal third', '🏅 medal']],
  ['Travel', ['🚗 car', '🚕 taxi', '🚌 bus', '🏎 race car', '🚓 police car', '🚑 ambulance', '🚒 fire truck', '🚚 truck delivery', '🚜 tractor', '🛴 scooter kick', '🚲 bicycle bike', '🛵 moped', '🏍 motorcycle', '✈️ airplane flight', '🚀 rocket launch ship', '🛸 ufo', '🚁 helicopter', '⛵ sailboat', '🚢 ship', '⚓ anchor', '🚦 traffic light', '🗺 map', '🗽 statue of liberty', '🏰 castle', '🎡 ferris wheel', '🎢 roller coaster', '⛲ fountain', '🏖 beach', '🏝 island', '⛰ mountain', '🗻 fuji', '⛺ tent camping', '🏠 house home', '🏢 office building', '🏥 hospital', '🏦 bank', '🏨 hotel', '🏫 school', '🗼 tower']],
  ['Objects', ['⌚ watch', '📱 phone mobile', '💻 laptop computer', '⌨️ keyboard', '🖥 desktop monitor', '🖨 printer', '🖱 mouse computer', '💾 floppy save', '💿 cd disc', '📷 camera', '📹 video camera', '🎥 movie camera', '📞 telephone call', '📺 tv television', '🧭 compass', '⏰ alarm clock', '⏳ hourglass time', '🔋 battery', '🔌 plug power', '💡 bulb idea light', '🔦 flashlight', '🕯 candle', '💸 money wings', '💵 dollar money cash', '💰 money bag', '💳 credit card', '💎 gem diamond', '🧰 toolbox', '🔧 wrench', '🔨 hammer', '🛠 hammer wrench tools', '⚙️ gear settings', '🔗 link chain', '📎 paperclip', '📏 ruler', '✂️ scissors cut', '🖊 pen', '✏️ pencil', '📝 memo note', '🔍 magnifier search', '🔒 locked', '🔓 unlocked', '🔑 key', '🚪 door', '🛏 bed', '🖼 picture frame', '🎁 gift present', '🎈 balloon', '🎉 party popper tada celebrate', '🎊 confetti', '📮 mailbox', '📦 package box', '📊 bar chart', '📈 chart up trending', '📉 chart down', '📅 calendar', '📋 clipboard', '📁 folder', '📰 newspaper', '📚 books', '📖 open book', '🔖 bookmark', '📌 pin', '📍 location pin', '💊 pill medicine', '💉 syringe', '🧬 dna', '🔬 microscope', '🔭 telescope', '🧪 test tube experiment', '🌡 thermometer']],
  ['Symbols', ['❤️ red heart love', '🧡 orange heart', '💛 yellow heart', '💚 green heart', '💙 blue heart', '💜 purple heart', '🖤 black heart', '🤍 white heart', '💔 broken heart', '💕 two hearts', '💖 sparkling heart', '✅ check mark done yes', '❌ cross x no wrong', '❎ cross mark button', '➕ plus add', '➖ minus', '➗ divide', '✖️ multiply', '💯 hundred percent', '🚫 prohibited no', '⚠️ warning caution', '⛔ no entry', '♻️ recycle', '❓ question mark', '❗ exclamation', '‼️ double exclamation', '🔴 red circle', '🟠 orange circle', '🟡 yellow circle', '🟢 green circle', '🔵 blue circle', '🟣 purple circle', '⚫ black circle', '⚪ white circle', '🔶 orange diamond', '🔷 blue diamond', '🔔 bell notification', '🔕 bell off mute', '📣 megaphone announce', '➡️ arrow right', '⬅️ arrow left', '⬆️ arrow up', '⬇️ arrow down', '↩️ return back', '🔀 shuffle', '🔁 repeat loop', '▶️ play', '⏸ pause', '⏹ stop', '⏩ fast forward', '🔼 up button', '🔽 down button', '🆕 new', '🆗 ok', '🆙 up', '🆒 cool', '🆓 free']]
];

let emojiCaret = null;

function recentEmoji() {
  try { return JSON.parse(localStorage.getItem('recentEmoji') || '[]'); } catch (e) { return []; }
}

function rememberEmoji(ch) {
  try {
    const list = [ch, ...recentEmoji().filter((x) => x !== ch)].slice(0, 16);
    localStorage.setItem('recentEmoji', JSON.stringify(list));
  } catch (e) { /* private mode */ }
}

function renderEmojiGrid() {
  const q = canon($('emojiSearch').value);
  const grid = $('emojiGrid');
  const cell = (ch, name) =>
    `<button class="emoji-cell" data-emoji="${ch}" title="${escapeHtml(name)}">${ch}</button>`;
  if (q) {
    const hits = [];
    for (const [, list] of EMOJI_SETS) {
      for (const entry of list) {
        const sp = entry.indexOf(' ');
        const name = entry.slice(sp + 1);
        if (name.includes(q)) hits.push(cell(entry.slice(0, sp), name));
        if (hits.length >= 60) break;
      }
      if (hits.length >= 60) break;
    }
    grid.innerHTML = hits.length ? hits.join('') : '<div class="emoji-none">No match.</div>';
    return;
  }
  let html = '';
  const recent = recentEmoji();
  if (recent.length) {
    html += '<div class="emoji-cat">Recent</div>' + recent.map((ch) => cell(ch, '')).join('');
  }
  for (const [category, list] of EMOJI_SETS) {
    html += `<div class="emoji-cat">${category}</div>`;
    html += list.map((entry) => {
      const sp = entry.indexOf(' ');
      return cell(entry.slice(0, sp), entry.slice(sp + 1));
    }).join('');
  }
  grid.innerHTML = html;
}

function openEmoji() {
  const box = tbb();
  emojiCaret = { s: box.selectionStart, e: box.selectionEnd };
  const panel = $('emojiPanel');
  panel.hidden = false;
  const btn = $('emojiBtn');
  panel.style.left = Math.max(0, Math.min(btn.offsetLeft, $('editorToolbar').clientWidth - 330)) + 'px';
  $('emojiSearch').value = '';
  renderEmojiGrid();
  $('emojiSearch').focus();
}

function closeEmoji() {
  $('emojiPanel').hidden = true;
  tbb().focus();
}

function pickEmoji(ch) {
  closeEmoji();
  tbReplace(emojiCaret.s, emojiCaret.e, ch);
  rememberEmoji(ch);
  tbDirty();
}

$('emojiBtn').addEventListener('click', () => {
  $('emojiPanel').hidden ? openEmoji() : closeEmoji();
});

$('emojiGrid').addEventListener('click', (e) => {
  const cellBtn = e.target.closest('.emoji-cell');
  if (cellBtn) pickEmoji(cellBtn.dataset.emoji);
});

$('emojiSearch').addEventListener('input', renderEmojiGrid);
$('emojiSearch').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeEmoji();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const first = $('emojiGrid').querySelector('.emoji-cell');
    if (first) pickEmoji(first.dataset.emoji);
  }
});

document.addEventListener('mousedown', (e) => {
  if (!$('emojiPanel').hidden && !e.target.closest('#emojiPanel, #emojiBtn')) {
    $('emojiPanel').hidden = true;
  }
});

/* ——— text color ——— */

let colorCaret = null;
let colorMode = 'text'; // 'text' wraps the selection; 'bg' sets the slide background

function openColorPanel() {
  colorMode = 'text';
  const box = tbb();
  colorCaret = { s: box.selectionStart, e: box.selectionEnd };
  const panel = $('colorPanel');
  panel.hidden = false;
  const btn = $('colorBtn');
  panel.style.left = Math.max(0, Math.min(btn.offsetLeft, $('editorToolbar').clientWidth - 260)) + 'px';
}

function openColorPanelFor(mode, anchorBtn) {
  colorMode = mode;
  const panel = $('colorPanel');
  panel.hidden = false;
  // These buttons live outside the toolbar the panel is anchored in.
  const btnRect = anchorBtn.getBoundingClientRect();
  const tbRect = $('editorToolbar').getBoundingClientRect();
  panel.style.left = Math.max(0, Math.min(btnRect.left - tbRect.left, $('editorToolbar').clientWidth - 260)) + 'px';
}

function applyPickedColor(color) {
  if (colorMode === 'bg') {
    setSlideBackground(color);
    closeColorPanel();
  } else if (colorMode === 'fg') {
    setSlideTextColor(color);
    closeColorPanel();
  } else {
    applyTextColor(color);
  }
}

function closeColorPanel() {
  $('colorPanel').hidden = true;
}

function applyTextColor(color) {
  if (!colorCaret) return;
  const box = tbb();
  let sel = box.value.slice(colorCaret.s, colorCaret.e) || 'colored text';
  // Re-coloring an already-colored selection swaps the color instead of nesting.
  const existing = sel.match(/^<span style="color:[^"]*">([\s\S]*)<\/span>$/);
  if (existing) sel = existing[1];
  const wrapped = `<span style="color:${color}">${sel}</span>`;
  tbReplace(colorCaret.s, colorCaret.e, wrapped);
  const inner = colorCaret.s + wrapped.indexOf('>') + 1;
  box.setSelectionRange(inner, inner + sel.length);
  closeColorPanel();
  tbDirty();
}

function clearTextColor() {
  if (!colorCaret) return;
  const box = tbb();
  const v = box.value;
  let { s, e } = colorCaret;
  let sel = v.slice(s, e);
  // Selections usually sit inside the span — expand to the enclosing one.
  if (!/<span style="color:/.test(sel)) {
    const openIdx = v.lastIndexOf('<span style="color:', s);
    if (openIdx !== -1) {
      const openEnd = v.indexOf('>', openIdx);
      const closeIdx = v.indexOf('</span>', Math.max(openEnd, e));
      const firstCloseAfterOpen = v.indexOf('</span>', openEnd);
      if (openEnd !== -1 && openEnd < s && closeIdx !== -1 && firstCloseAfterOpen >= e) {
        s = openIdx;
        e = closeIdx + '</span>'.length;
        sel = v.slice(s, e);
      }
    }
  }
  const stripped = sel.replace(/<span style="color:[^"]*">/g, '').replace(/<\/span>/g, '');
  if (stripped !== sel) {
    tbReplace(s, e, stripped);
    box.setSelectionRange(s, s + stripped.length);
    tbDirty();
  }
  closeColorPanel();
}

$('colorBtn').addEventListener('click', () => {
  $('colorPanel').hidden ? openColorPanel() : closeColorPanel();
});
$('colorPanel').addEventListener('click', (e) => {
  const swatch = e.target.closest('.color-swatch');
  if (swatch) applyPickedColor(swatch.dataset.color);
  else if (e.target.closest('#colorClear')) {
    if (colorMode === 'bg') {
      setSlideBackground(null);
      closeColorPanel();
    } else if (colorMode === 'fg') {
      setSlideTextColor(null);
      closeColorPanel();
    } else {
      clearTextColor();
    }
  }
});
$('colorCustom').addEventListener('change', (e) => applyPickedColor(e.target.value));
$('colorCustomBtn').addEventListener('click', () => {
  // Opens the OS color dialog: draggable spectrum + manual RGB/hex entry.
  try { $('colorCustom').showPicker(); } catch (e) { $('colorCustom').click(); }
});
document.addEventListener('mousedown', (e) => {
  if (!$('colorPanel').hidden && !e.target.closest('#colorPanel, #colorBtn')) closeColorPanel();
});

/* ——— paste / drop attachments into the editor ——— */

async function insertAttachment(box, blob, nameHint) {
  const { file, model } = await api.upload(blob, nameHint);
  // A converted .blend embeds its .glb; the source .blend stays alongside.
  const embedFile = model || file;
  const isImage = /\.(png|jpe?g|gif|webp|svg)$/i.test(embedFile);
  const md = isImage ? `![](@attachment/${embedFile})` : `[${embedFile}](@attachment/${embedFile})`;
  box.focus();
  document.execCommand('insertText', false, md + '\n');
  if (box === ed) {
    setDirty(true);
  } else {
    deckEd.dirty = true;
    scheduleDeckPreview();
  }
}

// Paste or drop images/files into either editor — main note or deck slide.
function wireAttachmentInput(box) {
  box.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.items || [])]
      .filter((i) => i.kind === 'file')
      .map((i) => i.getAsFile())
      .filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    (async () => {
      // Chrome names clipboard screenshots "image.png" — let the server pick a dated name.
      for (const f of files) await insertAttachment(box, f, f.name === 'image.png' ? '' : f.name);
    })();
  });
  box.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });
  box.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    (async () => {
      for (const f of files) await insertAttachment(box, f, f.name);
    })();
  });
}

wireAttachmentInput(ed);
wireAttachmentInput($('deckCode'));

// Toolbar "3D" button: pick model files, upload, insert as viewer links.
// .blend files are converted server-side; insertAttachment embeds the .glb.
const model3dFile = document.createElement('input');
model3dFile.type = 'file';
model3dFile.accept = '.glb,.gltf,.blend';
model3dFile.multiple = true;
$('model3dBtn').addEventListener('click', () => model3dFile.click());
model3dFile.addEventListener('change', async () => {
  const files = [...model3dFile.files];
  model3dFile.value = '';
  for (const f of files) await insertAttachment(tbb(), f, f.name);
});

/* ——— quick-open (⌘P) ——— */

let quickSel = 0;

function quickMatches(q) {
  const tokens = canon(q).split(/\s+/).filter(Boolean);
  if (!tokens.length) {
    return [...state.notes].sort((a, b) => new Date(b.modified) - new Date(a.modified)).slice(0, 10);
  }
  return state.notes
    .map((n) => {
      const title = canon(n.title);
      const inTitle = tokens.every((t) => title.includes(t));
      const inBody = tokens.every((t) => title.includes(t) || canon(n.body).includes(t));
      const score = inTitle ? (title.startsWith(tokens[0]) ? 3 : 2) : inBody ? 1 : 0;
      return { n, score };
    })
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score || new Date(y.n.modified) - new Date(x.n.modified))
    .slice(0, 10)
    .map((x) => x.n);
}

function renderQuick() {
  const items = quickMatches($('quickInput').value);
  $('quickList').innerHTML = items
    .map(
      (n, i) =>
        `<button class="suggest-item${i === quickSel ? ' active' : ''}" data-file="${escapeHtml(n.file)}">
          ${escapeHtml(n.title)}<span class="suggest-date">${formatDate(n.modified)}</span>
        </button>`
    )
    .join('');
  return items;
}

function openQuick() {
  quickSel = 0;
  $('quickOpen').hidden = false;
  $('quickInput').value = '';
  renderQuick();
  $('quickInput').focus();
}

function closeQuick() {
  $('quickOpen').hidden = true;
}

$('quickInput').addEventListener('input', () => {
  quickSel = 0;
  renderQuick();
});
$('quickInput').addEventListener('keydown', (e) => {
  const items = quickMatches($('quickInput').value);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (items.length) {
      quickSel = e.key === 'ArrowDown'
        ? (quickSel + 1) % items.length
        : quickSel <= 0 ? items.length - 1 : quickSel - 1;
      renderQuick();
    }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (items[quickSel]) {
      closeQuick();
      openNote(items[quickSel].file);
    }
  } else if (e.key === 'Escape') {
    closeQuick();
  }
});
$('quickOpen').addEventListener('mousedown', (e) => {
  if (e.target === $('quickOpen')) closeQuick();
});
$('quickList').addEventListener('click', (e) => {
  const btn = e.target.closest('.suggest-item');
  if (btn) {
    closeQuick();
    openNote(btn.dataset.file);
  }
});

/* ——— find in note (⌘F) ——— */

let findMarks = [];
let findIndex = -1;

function clearFindMarks() {
  for (const m of findMarks) m.replaceWith(document.createTextNode(m.textContent));
  if (findMarks.length) $('rendered').normalize();
  findMarks = [];
  findIndex = -1;
}

function applyFind(query) {
  clearFindMarks();
  $('findCount').textContent = '';
  if (!query) return;
  if (state.editing) {
    // In the editor, just count; Enter steps through selections.
    const q = query.toLowerCase();
    let count = 0;
    let i = ed.value.toLowerCase().indexOf(q);
    while (i !== -1 && count < 1000) {
      count++;
      i = ed.value.toLowerCase().indexOf(q, i + 1);
    }
    $('findCount').textContent = count ? `${count} hit${count === 1 ? '' : 's'}` : 'no hits';
    return;
  }
  const root = $('rendered');
  const q = query.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.parentElement.closest('svg')) return NodeFilter.FILTER_REJECT;
      return node.nodeValue.toLowerCase().includes(q)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP;
    }
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    const lower = text.toLowerCase();
    const frag = document.createDocumentFragment();
    let last = 0;
    let idx = lower.indexOf(q);
    while (idx !== -1) {
      frag.appendChild(document.createTextNode(text.slice(last, idx)));
      const mark = document.createElement('mark');
      mark.className = 'find-hit';
      mark.textContent = text.slice(idx, idx + query.length);
      frag.appendChild(mark);
      findMarks.push(mark);
      last = idx + query.length;
      idx = lower.indexOf(q, last);
    }
    frag.appendChild(document.createTextNode(text.slice(last)));
    node.replaceWith(frag);
  }
  if (findMarks.length) stepFind(0, true);
  else $('findCount').textContent = 'no hits';
}

function stepFind(direction, absolute) {
  if (state.editing) {
    const q = $('findInput').value.toLowerCase();
    if (!q) return;
    const from = direction >= 0 ? ed.selectionEnd : Math.max(0, ed.selectionStart - 1);
    let pos = direction >= 0
      ? ed.value.toLowerCase().indexOf(q, from)
      : ed.value.toLowerCase().lastIndexOf(q, from - 1);
    if (pos === -1) {
      pos = direction >= 0
        ? ed.value.toLowerCase().indexOf(q)
        : ed.value.toLowerCase().lastIndexOf(q);
    }
    if (pos === -1) return;
    ed.focus();
    ed.setSelectionRange(pos, pos + q.length);
    $('findInput').focus();
    return;
  }
  if (!findMarks.length) return;
  if (findIndex >= 0) findMarks[findIndex].classList.remove('current');
  findIndex = absolute
    ? direction
    : (findIndex + direction + findMarks.length) % findMarks.length;
  const mark = findMarks[findIndex];
  mark.classList.add('current');
  const details = mark.closest('details');
  if (details) details.open = true;
  mark.scrollIntoView({ block: 'center' });
  $('findCount').textContent = `${findIndex + 1}/${findMarks.length}`;
}

function openFind() {
  if (!state.current) return;
  $('findBar').hidden = false;
  const input = $('findInput');
  input.focus();
  input.select();
  if (input.value) applyFind(input.value);
}

function closeFind() {
  clearFindMarks();
  $('findBar').hidden = true;
  $('findCount').textContent = '';
}

$('findInput').addEventListener('input', (e) => applyFind(e.target.value));
$('findInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    stepFind(e.shiftKey ? -1 : 1);
  } else if (e.key === 'Escape') {
    closeFind();
  }
});
$('findNext').addEventListener('click', () => stepFind(1));
$('findPrev').addEventListener('click', () => stepFind(-1));
$('findClose').addEventListener('click', closeFind);

// mousedown would move focus out of the textarea and lose the selection —
// except the emoji panel's search input and the native color input.
$('editorToolbar').addEventListener('mousedown', (e) => {
  if (!e.target.closest('input, select')) e.preventDefault();
});
$('editorToolbar').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-md]');
  if (btn && toolbarActions[btn.dataset.md]) toolbarActions[btn.dataset.md]();
});

ed.addEventListener('keydown', (e) => {
  if (handleSuggestKeys(e)) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && !e.shiftKey && !e.altKey && e.key === 'b') {
    e.preventDefault();
    toolbarActions.bold();
  } else if (mod && !e.shiftKey && !e.altKey && e.key === 'i') {
    e.preventDefault();
    toolbarActions.italic();
  } else if (mod && !e.shiftKey && !e.altKey && e.key === 'k') {
    e.preventDefault();
    toolbarActions.link();
  } else if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    edReplace(ed.selectionStart, ed.selectionEnd, '  ');
    setDirty(true);
  }
});

$('rendered').addEventListener('change', (e) => {
  if (e.target.matches('input[type="checkbox"]')) toggleTask(Number(e.target.dataset.taskIndex));
});

let createKind = 'note';

function slidesStarter(title) {
  return (
    `<!-- transition: slide -->\n\n# ${title}\n\nA subtitle, or who it's for\n\n---\n\n` +
    `## First point\n\n<!-- steps -->\n\n- One thing\n- Another thing\n- The punchline\n\n---\n\n## Thanks 🎉\n`
  );
}

$('newNote').addEventListener('click', () => {
  const menu = $('createMenu');
  menu.hidden = !menu.hidden;
  $('newNoteForm').hidden = true;
});

$('createMenu').addEventListener('click', (e) => {
  const item = e.target.closest('[data-create]');
  if (!item) return;
  $('createMenu').hidden = true;
  if (item.dataset.create === 'meeting') {
    startMeeting();
    return;
  }
  createKind = item.dataset.create;
  $('newNoteTitle').placeholder =
    createKind === 'slides' ? 'Presentation title, then Enter…' : 'Note title, then Enter…';
  $('newNoteForm').hidden = false;
  $('newNoteTitle').focus();
});

document.addEventListener('mousedown', (e) => {
  if (!$('createMenu').hidden && !e.target.closest('#createMenu, #newNote')) {
    $('createMenu').hidden = true;
  }
});

$('newNoteTitle').addEventListener('keydown', async (e) => {
  if (e.key === 'Escape') {
    $('newNoteForm').hidden = true;
  } else if (e.key === 'Enter') {
    const title = $('newNoteTitle').value.trim();
    if (!title) return;
    const { file } = await api.create(title);
    if (createKind === 'slides') {
      let raw = await api.raw(file);
      raw = setTagsInRaw(raw, ['Presentation']);
      // Replace the default body with a starter deck.
      const fmEnd = frontmatterEndIndex(raw);
      raw = raw.slice(0, fmEnd) + '\n' + slidesStarter(title);
      await api.save(file, raw);
    } else if (createKind === 'template' && createTemplateFile) {
      const { body, tags } = await bodyFromTemplate(createTemplateFile, title);
      let raw = await api.raw(file);
      if (tags.length) raw = setTagsInRaw(raw, tags);
      const fmEnd = frontmatterEndIndex(raw);
      raw = raw.slice(0, fmEnd) + '\n' + body;
      await api.save(file, raw);
    }
    state.notes = await api.list();
    $('newNoteTitle').value = '';
    $('newNoteForm').hidden = true;
    renderTags();
    renderList();
    openNote(file);
    if (createKind === 'slides') openDeckEditor();
    else if (createKind === 'template' && isDeckNote(state.current)) openDeckEditor();
    else enterEdit();
  }
});

/* ——— trash view ——— */

async function refreshTrashCount() {
  try {
    const items = await api.trash();
    $('trashCount').textContent = items.length ? `(${items.length})` : '';
  } catch (e) { /* server unavailable */ }
}

async function openTrash() {
  const items = await api.trash();
  $('empty').hidden = true;
  $('noteView').hidden = true;
  $('meetingView').hidden = true;
  $('todoView').hidden = true;
  $('trashView').hidden = false;
  closeFind();
  document.title = 'Trash — Marknote';
  $('trashList').innerHTML = items.length
    ? items
        .map(
          (t) => `<div class="trash-row">
            <span class="trash-name">${escapeHtml(t.original.replace(/\.md$/, ''))}</span>
            <span class="trash-date">${t.deleted ? formatDate(t.deleted) : ''}</span>
            <button data-restore="${escapeHtml(t.file)}">Restore</button>
            <button class="danger" data-forever="${escapeHtml(t.file)}">Delete forever</button>
          </div>`
        )
        .join('')
    : '<p class="trash-empty">Trash is empty.</p>';
}

$('trashBtn').addEventListener('click', openTrash);
$('trashClose').addEventListener('click', () => {
  $('trashView').hidden = true;
  if (state.current) $('noteView').hidden = false;
  else $('empty').hidden = false;
  document.title = state.current ? state.current.title + ' — Marknote' : 'Marknote';
});

$('trashList').addEventListener('click', async (e) => {
  const restore = e.target.closest('[data-restore]');
  const forever = e.target.closest('[data-forever]');
  if (restore) {
    await api.trashAction('restore', restore.dataset.restore);
    state.notes = await api.list();
    renderTags();
    renderList();
    refreshTrashCount();
    openTrash();
  } else if (forever) {
    if (!forever.classList.contains('confirming')) {
      forever.classList.add('confirming');
      forever.textContent = 'Really?';
      setTimeout(() => {
        forever.classList.remove('confirming');
        forever.textContent = 'Delete forever';
      }, 3000);
      return;
    }
    await api.trashAction('delete', forever.dataset.forever);
    refreshTrashCount();
    openTrash();
  }
});

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  // Presentation mode: Esc exits; arrows/space belong to the deck; the
  // app's own shortcuts stay out of the way.
  if (deck) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closePresentation();
    }
    return;
  }
  // Deck editor open (and mermaid modal not on top of it): Esc = done;
  // with focus outside any field, ↑/↓ walk through the slides.
  if (deckEd.open && $('mmModal').hidden) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeDeckEditor();
      return;
    }
    const t = document.activeElement;
    const inField = t && t.matches('input, textarea, select');
    if (!inField && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      deckLoadSlide(deckEd.cur + (e.key === 'ArrowDown' ? 1 : -1));
    }
    return;
  }
  // While editing a note, undo/redo always applies to the note editor — even
  // if focus drifted to the search bar or a button. With focus already in the
  // editor, native undo handles it; the mermaid editor keeps its own undo.
  if (mod && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
    if (state.editing && !$('editorWrap').hidden && $('mmModal').hidden && document.activeElement !== ed) {
      e.preventDefault();
      ed.focus();
      const before = ed.value;
      document.execCommand(e.shiftKey ? 'redo' : 'undo');
      if (ed.value !== before) setDirty(true);
    }
    return;
  }
  if (mod && e.key === 'p') {
    e.preventDefault();
    openQuick();
    return;
  }
  if (mod && e.key === 'f') {
    e.preventDefault();
    openFind();
    return;
  }
  if (mod && e.key === 's') {
    e.preventDefault();
    saveEditor();
  } else if (mod && e.key === 'e' && state.current) {
    e.preventDefault();
    state.editing ? exitEdit({ save: true }) : enterEdit();
  } else if (e.key === '/' && !e.target.matches('input, textarea')) {
    e.preventDefault();
    $('search').focus();
    $('search').select();
  } else if (e.key === 'Escape' && e.target === $('search')) {
    e.target.blur();
  }
});

window.addEventListener('beforeunload', (e) => {
  if (state.dirty || rec.recorder) e.preventDefault();
});

// React to hash changes from outside the app (back/forward, pasted #note/ links).
// Notes created outside the app (agents, scripts, other editors) appear
// when the window regains focus — no manual reload needed.
window.addEventListener('focus', async () => {
  try {
    state.notes = await api.list();
    renderTags();
    renderList();
    refreshTrashCount();
    // Refresh the open note's rendered view if it changed on disk,
    // but never while the user is editing it.
    if (state.current && !state.editing && !deckEd.open) {
      const fresh = state.notes.find((n) => n.file === state.current.file);
      if (fresh && fresh.modified !== state.current.modified) {
        state.current = fresh;
        renderMarkdown($('rendered'), fresh.body);
        renderBacklinks(fresh);
        $('noteDate').textContent = formatDate(fresh.modified);
      }
    }
  } catch (e) { /* server briefly unavailable */ }
});

window.addEventListener('hashchange', () => {
  const hash = decodeURIComponent(location.hash);
  if (!hash.startsWith('#note/')) return;
  const file = hash.slice('#note/'.length);
  if (!state.current || state.current.file !== file) openNote(file);
});

$('themeToggle').addEventListener('click', () => {
  setTheme(effectiveTheme() === 'dark' ? 'light' : 'dark');
});

/* ——— boot ——— */

(async function init() {
  $('themeToggle').textContent = effectiveTheme() === 'dark' ? '☾' : '☀';
  initMermaid();
  refreshTrashCount();
  state.notes = await api.list();
  renderTags();
  renderList();
  const hash = decodeURIComponent(location.hash);
  if (hash.startsWith('#note/')) openNote(hash.slice('#note/'.length));

  // Recordings rescued from a crash become notes so they're not lost.
  try {
    const recovered = await fetch('/api/recovered').then((r) => r.json());
    for (const f of recovered) {
      const { file } = await api.create(f.replace(/\.weba$/, '').replace(/-/g, ' '));
      let raw = await api.raw(file);
      raw = setTagsInRaw(raw, ['Meeting']);
      raw = raw.replace(/\n*$/, `\n[Recording](@attachment/${f})\n`);
      await api.save(file, raw);
    }
    if (recovered.length) {
      state.notes = await api.list();
      renderTags();
      renderList();
      alertBar(`Recovered ${recovered.length} interrupted recording${recovered.length === 1 ? '' : 's'}`);
    }
  } catch (e) { /* recovery is best-effort */ }
})();

/* ——— todos ——— */
// Todos are plain task-list lines in notes/Todos.md, so they stay an editable
// note and survive in git. Tokens: @YYYY-MM-DD due date, !HH:MM reminder time
// (the server fires a macOS notification), trailing [[Note]] = source link.

const TODOS_FILE = 'Todos.md';
let todoRaw = null;

async function loadTodos() {
  try { todoRaw = await api.raw(TODOS_FILE); } catch { todoRaw = null; }
}

async function ensureTodosNote() {
  if (state.notes.find((n) => n.file === TODOS_FILE)) return;
  const iso = new Date().toISOString();
  await api.save(TODOS_FILE, `---\ntags: [Todos]\ntitle: 'Todos'\ncreated: '${iso}'\nmodified: '${iso}'\n---\n\n# Todos\n`);
  state.notes = await api.list();
  renderTags();
  renderList();
}

function parseTodos(text) {
  const items = [];
  (text || '').split('\n').forEach((line, idx) => {
    const m = line.match(/^- \[( |x)\] (.*)$/);
    if (!m) return;
    const t = { idx, done: m[1] === 'x', date: null, time: null, link: null };
    const dm = m[2].match(/@(\d{4}-\d{2}-\d{2})/);
    if (dm) t.date = dm[1];
    const tm = m[2].match(/!(\d{1,2}:\d{2})/);
    if (tm) t.time = tm[1];
    const lm = m[2].match(/\[\[([^\]\n]+)\]\]/);
    if (lm) t.link = lm[1];
    t.label = m[2]
      .replace(/@\d{4}-\d{2}-\d{2}/, '').replace(/!\d{1,2}:\d{2}/, '')
      .replace(/\[\[[^\]\n]+\]\]/, '').replace(/\s+/g, ' ').trim();
    items.push(t);
  });
  return items;
}

function todayStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function updateTodoCount() {
  const n = state.notes.find((x) => x.file === TODOS_FILE);
  const open = n ? parseTodos(n.body).filter((t) => !t.done).length : 0;
  $('todoCount').textContent = open ? `(${open})` : '';
}

function renderTodos() {
  const items = parseTodos(todoRaw);
  const today = todayStr();
  const tomorrow = todayStr(1);
  const dow = (new Date().getDay() + 6) % 7; // Monday = 0
  const weekEnd = todayStr(6 - dow);
  const groups = { Overdue: [], Today: [], Tomorrow: [], 'This week': [], Later: [], 'No date': [], Done: [] };
  for (const t of items) {
    if (t.done) groups.Done.push(t);
    else if (!t.date) groups['No date'].push(t);
    else if (t.date < today) groups.Overdue.push(t);
    else if (t.date === today) groups.Today.push(t);
    else if (t.date === tomorrow) groups.Tomorrow.push(t);
    else if (t.date <= weekEnd) groups['This week'].push(t);
    else groups.Later.push(t);
  }
  $('todoGroups').innerHTML = Object.entries(groups)
    .filter(([, list]) => list.length)
    .map(([name, list]) => {
      const rows = list
        .map((t) => {
          const src = t.link
            ? `<a class="todo-src" href="#note/${encodeURIComponent((resolveNote(t.link) || { file: t.link + '.md' }).file)}">↳ ${escapeHtml(t.link)}</a>`
            : '';
          return `<div class="todo-item${t.done ? ' is-done' : ''}${name === 'Overdue' ? ' is-overdue' : ''}">
            <input type="checkbox" ${t.done ? 'checked' : ''} data-toggle="${t.idx}" title="${t.done ? 'Reopen' : 'Mark done'}">
            <span class="todo-label">${escapeHtml(t.label)}</span>
            ${t.date ? `<span class="todo-chip chip-date">📅 ${t.date === today ? 'today' : t.date === tomorrow ? 'tomorrow' : t.date}</span>` : ''}
            ${t.time ? `<span class="todo-chip chip-bell">🔔 ${t.time}</span>` : ''}
            ${src}
            <button class="todo-del" data-del="${t.idx}" title="Remove todo">×</button>
          </div>`;
        })
        .join('');
      return `<details class="todo-group${name === 'Overdue' ? ' g-overdue' : ''}"${name === 'Done' ? '' : ' open'}>
        <summary>${name} <span class="todo-gcount">${list.length}</span></summary>
        <div class="todo-rows">${rows}</div></details>`;
    })
    .join('') || '<div class="todo-empty"><div class="todo-empty-mark">❦</div>All clear — nothing to do.</div>';
  updateTodoCount();
}

async function openTodoView() {
  $('empty').hidden = true;
  $('noteView').hidden = true;
  $('meetingView').hidden = true;
  $('trashView').hidden = true;
  $('todoView').hidden = false;
  closeFind();
  document.title = 'Todos — Marknote';
  history.replaceState(null, '', '#todos');
  await loadTodos();
  renderTodos();
  $('todoText').focus();
}

$('todosBtn').addEventListener('click', openTodoView);
$('todoClose').addEventListener('click', () => {
  $('todoView').hidden = true;
  if (state.current) {
    $('noteView').hidden = false;
    document.title = state.current.title + ' — Marknote';
    history.replaceState(null, '', '#note/' + encodeURIComponent(state.current.file));
  } else {
    $('empty').hidden = false;
    document.title = 'Marknote';
    history.replaceState(null, '', '#');
  }
});

async function appendTodos(entries) {
  await ensureTodosNote();
  await loadTodos();
  const lines = (todoRaw ?? '').split('\n');
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  lines.push(...entries, '');
  const updated = await api.save(TODOS_FILE, lines.join('\n'));
  const i = state.notes.findIndex((n) => n.file === TODOS_FILE);
  if (i !== -1) state.notes[i] = updated;
  await loadTodos();
  updateTodoCount();
}

async function submitTodoForm() {
  const label = $('todoText').value.trim();
  if (!label) return;
  let date = $('todoDate').value;
  const time = $('todoTime').value;
  if (time && !date) date = todayStr(); // a bare reminder time means today
  let entry = `- [ ] ${label}`;
  if (date) entry += ` @${date}`;
  if (time) entry += ` !${time}`;
  $('todoText').value = '';
  $('todoDate').value = '';
  $('todoTime').value = '';
  tcSyncPills();
  await appendTodos([entry]);
  renderTodos();
  $('todoText').focus();
}

$('todoAdd').addEventListener('click', submitTodoForm);
$('todoText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitTodoForm();
});

$('todoGroups').addEventListener('click', async (e) => {
  const toggle = e.target.closest('[data-toggle]');
  const del = e.target.closest('[data-del]');
  if (!toggle && !del) return;
  await loadTodos();
  const lines = (todoRaw ?? '').split('\n');
  const idx = Number(toggle ? toggle.dataset.toggle : del.dataset.del);
  if (!/^- \[( |x)\] /.test(lines[idx] || '')) { renderTodos(); return; } // file changed underneath
  if (toggle) {
    lines[idx] = lines[idx].startsWith('- [ ]')
      ? lines[idx].replace('- [ ]', '- [x]')
      : lines[idx].replace('- [x]', '- [ ]');
  } else {
    lines.splice(idx, 1);
  }
  const updated = await api.save(TODOS_FILE, lines.join('\n'));
  const i = state.notes.findIndex((n) => n.file === TODOS_FILE);
  if (i !== -1) state.notes[i] = updated;
  await loadTodos();
  renderTodos();
});

/* suggest todos from a meeting note via the claude CLI */

let tsSuggestions = [];

$('todoSuggestBtn').addEventListener('click', async () => {
  const note = state.current;
  if (!note) return;
  $('todoSuggestModal').hidden = false;
  $('tsAdd').disabled = true;
  $('tsList').innerHTML = '<p class="ts-loading">Asking Claude to read the note…</p>';
  try {
    const res = await fetch('/api/todo-suggest', {
      method: 'POST',
      body: JSON.stringify({ text: note.body, title: note.title })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'request failed');
    tsSuggestions = data.suggestions || [];
    if (!tsSuggestions.length) {
      $('tsList').innerHTML = '<p class="ts-loading">No action items found in this note.</p>';
      return;
    }
    $('tsList').innerHTML = tsSuggestions
      .map((s, i) => `<label class="ts-item"><input type="checkbox" checked data-ts="${i}"><span>${escapeHtml(s)}</span></label>`)
      .join('');
    $('tsAdd').disabled = false;
  } catch (err) {
    $('tsList').innerHTML = `<p class="ts-loading">Could not get suggestions: ${escapeHtml(String(err.message || err))}</p>`;
  }
});

$('tsCancel').addEventListener('click', () => { $('todoSuggestModal').hidden = true; });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('todoSuggestModal').hidden) $('todoSuggestModal').hidden = true;
});

$('tsAdd').addEventListener('click', async () => {
  const picked = [...$('tsList').querySelectorAll('input:checked')].map((el) => tsSuggestions[Number(el.dataset.ts)]);
  $('todoSuggestModal').hidden = true;
  if (!picked.length) return;
  const src = state.current ? state.current.title : null;
  await appendTodos(picked.map((p) => `- [ ] ${p.replace(/\n/g, ' ')}` + (src ? ` [[${src}]]` : '')));
  alertBar(`Added ${picked.length} todo${picked.length === 1 ? '' : 's'} — see ☑ Todos`);
});

// keep the sidebar count fresh; #todos deep-link restores the page on reload
setInterval(updateTodoCount, 30 * 1000);
setTimeout(updateTodoCount, 1500);
if (decodeURIComponent(location.hash) === '#todos') openTodoView();

/* composer popovers: 📅 due date and 🔔 reminder, shown as removable pills */

function tcSyncPills() {
  const date = $('todoDate').value;
  const time = $('todoTime').value;
  $('todoDatePill').hidden = !date;
  if (date) {
    $('todoDatePill').querySelector('.tc-pill-txt').textContent =
      '📅 ' + (date === todayStr() ? 'today' : date === todayStr(1) ? 'tomorrow' : date);
  }
  $('todoTimePill').hidden = !time;
  if (time) $('todoTimePill').querySelector('.tc-pill-txt').textContent = '🔔 ' + time;
  $('todoDateBtn').classList.toggle('active', !!date);
  $('todoBellBtn').classList.toggle('active', !!time);
}

function tcClosePops() {
  $('todoDatePop').hidden = true;
  $('todoBellPop').hidden = true;
}

$('todoDateBtn').addEventListener('click', () => {
  const was = $('todoDatePop').hidden;
  tcClosePops();
  $('todoDatePop').hidden = !was;
});
$('todoBellBtn').addEventListener('click', () => {
  const was = $('todoBellPop').hidden;
  tcClosePops();
  $('todoBellPop').hidden = !was;
});
$('todoDate').addEventListener('change', tcSyncPills);
$('todoTime').addEventListener('change', tcSyncPills);
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('.tc-pop, #todoDateBtn, #todoBellBtn')) tcClosePops();
});
document.querySelectorAll('#todoDatePop .tc-chip').forEach((b) =>
  b.addEventListener('click', () => {
    $('todoDate').value = todayStr(Number(b.dataset.day));
    tcClosePops();
    tcSyncPills();
    $('todoText').focus();
  })
);
document.querySelectorAll('#todoBellPop .tc-chip').forEach((b) =>
  b.addEventListener('click', () => {
    $('todoTime').value = b.dataset.clock;
    tcClosePops();
    tcSyncPills();
    $('todoText').focus();
  })
);
document.querySelectorAll('.tc-pill-x').forEach((b) =>
  b.addEventListener('click', () => {
    if (b.dataset.clear === 'date') $('todoDate').value = '';
    else $('todoTime').value = '';
    tcSyncPills();
    $('todoText').focus();
  })
);

// Keep the open todos page in sync with the file underneath it — the reminder
// dialog's "Klart ✓" marks todos done server-side, and agents/other windows
// can edit Todos.md too. Cheap: refetch only while the view is visible,
// re-render only when the content actually changed.
async function refreshTodosIfOpen() {
  if ($('todoView').hidden) return;
  const before = todoRaw;
  await loadTodos();
  if (todoRaw !== before) {
    renderTodos();
    state.notes = await api.list();
    renderList();
    updateTodoCount();
  }
}
setInterval(refreshTodosIfOpen, 5000);
window.addEventListener('focus', refreshTodosIfOpen);

/* ——— note ⋯ menu ——— */
// Rare actions live behind the ⋯ button. Delete keeps its two-click confirm:
// the arming click leaves the menu open so "Really delete?" stays visible.
$('noteMenuBtn').addEventListener('click', () => {
  $('noteMenu').hidden = !$('noteMenu').hidden;
});
$('noteMenu').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b && b.id !== 'deleteBtn') $('noteMenu').hidden = true;
});
document.addEventListener('mousedown', (e) => {
  if (!$('noteMenu').hidden && !e.target.closest('#noteMenu, #noteMenuBtn')) {
    $('noteMenu').hidden = true;
    resetDelete();
  }
});

/* ——— presenter mode: deck on a second screen, notes on this one ——— */
// The display window (opened at #display/<file>) runs only the reveal deck;
// the main window becomes the presenter view: current + next slide, speaker
// notes (<!-- notes ... --> per slide), timer and controls. The two sync over
// a BroadcastChannel; in the Electron app the display window is auto-placed
// fullscreen on the external screen (see main.js).

function slideNotes(chunk) {
  const m = (chunk || '').match(/<!--\s*notes:?\s*([\s\S]*?)-->/);
  return m ? m[1].trim() : '';
}

/* — display window side — */

async function bootDisplayMode() {
  document.body.classList.add('display-mode');
  document.title = 'Presentation — Marknote';
  const file = decodeURIComponent(location.hash.slice('#display/'.length));
  while (!state.notes.length) await new Promise((r) => setTimeout(r, 100));
  const note = state.notes.find((n) => n.file === file);
  if (!note) { document.body.textContent = 'Note not found: ' + file; return; }
  state.current = note;
  await openPresentation();
  const ch = new BroadcastChannel('marknote-present');
  const report = () => {
    if (!deck) return;
    ch.postMessage({ type: 'state', h: deck.getIndices().h, total: deck.getTotalSlides() });
  };
  ch.onmessage = (e) => {
    const m = e.data;
    if (!deck) return;
    if (m.type === 'next') deck.next();
    else if (m.type === 'prev') deck.prev();
    else if (m.type === 'goto') deck.slide(m.h, 0);
    else if (m.type === 'hello') report();
    else if (m.type === 'close') window.close();
  };
  deck.on('slidechanged', report);
  // Esc behaves exactly like ×: end the whole display window. Capture phase
  // so the app's own Esc handling can't interfere or reorder.
  const endDisplay = () => {
    try { ch.postMessage({ type: 'ended' }); } catch (e) { /* channel gone */ }
    setTimeout(() => window.close(), 120);
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      endDisplay();
    }
  }, true);
  // the presentation overlay's × ends the whole display window, not just the deck
  $('presentClose').addEventListener('click', endDisplay);
  // whatever closes this window — ×, Esc, red traffic light — tell the presenter
  window.addEventListener('pagehide', () => {
    try { ch.postMessage({ type: 'ended' }); } catch (e) { /* channel gone */ }
  });
  report();
}
if (location.hash.startsWith('#display/')) bootDisplayMode();

/* — presenter side — */

let presenterCh = null;
let displayWin = null;
let presenterTimer = null;
let presenterChunks = [];
let presenterH = 0;
let presenterFile = null;


// "3 · Motorn: Swedbank Pay" — option labels for the jump-to-slide dropdown
function slideTitle(chunk, i) {
  const h = (chunk || '').match(/^#{1,4}\s+(.+)$/m);
  let t = h ? h[1] : ((chunk || '').split('\n').find((l) => l.trim() && !l.trim().startsWith('<!--')) || '');
  t = t.replace(/[*_`#]/g, '').replace(/<[^>]+>/g, '').trim();
  if (t.length > 42) t = t.slice(0, 40) + '\u2026';
  return `${i + 1} \u00b7 ${t || '(slide)'}`;
}

async function renderPresenterSlides() {
  const cur = presenterChunks[presenterH] || '';
  const next = presenterChunks[presenterH + 1];
  $('presCounter').textContent = `${presenterH + 1} / ${presenterChunks.length}`;
  if ($('presSlidePick').value !== String(presenterH)) $('presSlidePick').value = String(presenterH);
  renderMarkdown($('presCurrent'), cur, { staticMermaid: true });
  $('presCurrent').querySelectorAll('.transcribe-btn, .diagram-edit').forEach((b) => b.remove());
  await renderMermaidStatic($('presCurrent'));
  if (next != null) {
    renderMarkdown($('presNext'), next, { staticMermaid: true });
    $('presNext').querySelectorAll('.transcribe-btn, .diagram-edit').forEach((b) => b.remove());
    await renderMermaidStatic($('presNext'));
  } else {
    $('presNext').innerHTML = '<div class="pres-end">— end of deck —</div>';
  }
  // mirror each slide's colors so the preview matches the big screen
  for (const [el, chunk] of [[$('presCurrent'), cur], [$('presNext'), next || '']]) {
    el.style.background = (chunk.match(/<!--\s*background:\s*(\S+)\s*-->/) || [])[1] || '';
    el.style.color = (chunk.match(/<!--\s*color:\s*(\S+)\s*-->/) || [])[1] || '';
  }
  const notes = slideNotes(cur);
  $('presNotes').textContent = notes || 'No speaker notes for this slide.';
  $('presNotes').classList.toggle('empty', !notes);
}

async function openPresenterMode() {
  const note = state.current;
  if (!note || displayWin) return;
  if (state.editing && state.dirty) {
    const updated = await api.save(note.file, await rawForSave($('editor').value));
    applySaved(updated);
  }
  presenterChunks = splitSlides(expandTransclusions(state.current.body));
  presenterH = 0;
  presenterFile = note.file;
  $('presSlidePick').innerHTML = presenterChunks
    .map((c, i) => `<option value="${i}">${escapeHtml(slideTitle(c, i))}</option>`)
    .join('');
  // In the desktop app the main process creates the display window on a chosen
  // screen (reliable cross-display fullscreen). In a plain browser we fall
  // back to window.open — drag it to the screen you want.
  const native = window.marknoteNative || null;
  if (native) {
    const displays = await native.displays();
    const pick = $('presDisplayPick');
    pick.innerHTML = displays
      .map((d) => `<option value="${d.id}">${escapeHtml(d.label)} ${d.width}×${d.height}${d.primary ? ' — this screen' : ''}</option>`)
      .join('') + '<option value="-1">Window — share in Teams/Zoom</option>';
    pick.hidden = false;
    const target = displays.find((d) => !d.primary) || displays[0];
    pick.value = String(target.id);
    await native.openDisplay(target.id, note.file);
    displayWin = 'native';
  } else {
    displayWin = window.open(location.origin + '/#display/' + encodeURIComponent(note.file), 'marknoteDisplay');
  }
  $('presenterView').hidden = false;
  $('presDisplayState').textContent = displayWin ? 'Waiting for display window…' : 'Popup blocked — allow popups and retry';
  presenterCh = new BroadcastChannel('marknote-present');
  presenterCh.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'ended') { closePresenterMode(); return; }
    if (m.type === 'state') {
      $('presDisplayState').textContent = 'Display connected';
      if (m.h !== presenterH) {
        presenterH = m.h;
        renderPresenterSlides();
      } else {
        $('presCounter').textContent = `${presenterH + 1} / ${presenterChunks.length}`;
      }
    }
  };
  let hellos = 0;
  const hi = setInterval(() => {
    if (!presenterCh) return clearInterval(hi);
    presenterCh.postMessage({ type: 'hello' });
    if (++hellos > 20) clearInterval(hi);
  }, 500);
  const t0 = Date.now();
  clearInterval(presenterTimer);
  presenterTimer = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    $('presTimer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
  $('presTimer').textContent = '0:00';
  renderPresenterSlides();
}

function closePresenterMode() {
  if (presenterCh) {
    presenterCh.postMessage({ type: 'close' });
    presenterCh.close();
    presenterCh = null;
  }
  if (window.marknoteNative) window.marknoteNative.closeDisplay();
  try { if (displayWin && displayWin !== 'native') displayWin.close(); } catch (e) { /* already gone */ }
  displayWin = null;
  clearInterval(presenterTimer);
  $('presenterView').hidden = true;
}

function presenterSend(type) {
  if (presenterCh) presenterCh.postMessage({ type });
}

$('presDisplayPick').addEventListener('change', () => {
  if (window.marknoteNative && presenterFile) {
    window.marknoteNative.openDisplay(Number($('presDisplayPick').value), presenterFile);
    $('presDisplayState').textContent = 'Moving display\u2026';
  }
});
// The main process tells us when the display window closed, however it
// closed — end presenter mode with it.
if (window.marknoteNative && window.marknoteNative.onDisplayClosed) {
  window.marknoteNative.onDisplayClosed(() => {
    if (!$('presenterView').hidden) closePresenterMode();
  });
}

$('presenterBtn').addEventListener('click', openPresenterMode);
$('presSlidePick').addEventListener('change', () => {
  if (presenterCh) presenterCh.postMessage({ type: 'goto', h: Number($('presSlidePick').value) });
});
$('presBtnNext').addEventListener('click', () => presenterSend('next'));
$('presBtnPrev').addEventListener('click', () => presenterSend('prev'));
$('presClose').addEventListener('click', closePresenterMode);
document.addEventListener('keydown', (e) => {
  if ($('presenterView').hidden) return;
  if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); presenterSend('next'); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); presenterSend('prev'); }
  else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopImmediatePropagation();
    closePresenterMode();
  }
}, true);

/* ——— PDF export ——— */
// #print/<file> renders the note as a clean A4 document, #printdeck/<file>
// as landscape slide pages. Always light theme; mermaid via the static
// renderer so diagrams come out correctly. window.__printReady tells the
// hidden Electron window (or a person in a browser tab) that it's safe to
// print. In the app the ⋯ menu button runs printToPDF via IPC.

async function bootPrintMode(deckMode) {
  document.body.classList.add('print-mode');
  document.documentElement.dataset.theme = 'light';
  mermaid.initialize({
    startOnLoad: false,
    theme: 'neutral',
    fontFamily: 'Figtree, sans-serif',
    suppressErrorRendering: true
  });
  const prefix = deckMode ? '#printdeck/' : '#print/';
  const file = decodeURIComponent(location.hash.slice(prefix.length));
  while (!state.notes.length) await new Promise((r) => setTimeout(r, 100));
  const note = state.notes.find((n) => n.file === file);
  if (!note) { document.title = 'Not found'; return; }
  document.title = note.title;

  if (isLockedBody(note.body)) {
    document.body.insertAdjacentHTML('beforeend', '<p style="padding:40px;font-size:18px">🔒 This note is locked and cannot be exported.</p>');
    window.__printReady = true;
    return;
  }
  const pageStyle = document.createElement('style');
  pageStyle.textContent = deckMode
    ? '@page { size: A4 landscape; margin: 0; }'
    : '@page { size: A4; margin: 16mm 18mm; }';
  document.head.appendChild(pageStyle);

  const root = document.createElement('div');
  root.id = 'printRoot';
  root.className = deckMode ? 'print-deck' : 'print-doc';
  document.body.appendChild(root);

  if (deckMode) {
    const chunks = splitSlides(expandTransclusions(note.body));
    for (const chunk of chunks) {
      const slide = document.createElement('div');
      slide.className = 'print-slide';
      const bg = (chunk.match(/<!--\s*background:\s*(\S+)\s*-->/) || [])[1];
      if (bg) slide.style.background = bg;
      const fg = (chunk.match(/<!--\s*color:\s*(\S+)\s*-->/) || [])[1];
      if (fg) slide.style.color = fg;
      const inner = document.createElement('div');
      inner.className = 'print-slide-inner rendered';
      slide.appendChild(inner);
      root.appendChild(slide);
      renderMarkdown(inner, chunk, { staticMermaid: true });
      inner.querySelectorAll('.transcribe-btn, .diagram-edit').forEach((b) => b.remove());
      await renderMermaidStatic(inner);
    }
  } else {
    const doc = document.createElement('div');
    doc.className = 'print-doc-inner rendered';
    root.appendChild(doc);
    renderMarkdown(doc, expandTransclusions(note.body), { staticMermaid: true });
    doc.querySelectorAll('.transcribe-btn, .diagram-edit').forEach((b) => b.remove());
    await renderMermaidStatic(doc);
  }

  await Promise.all(
    [...document.images].map((im) => (im.complete ? null : new Promise((r) => { im.onload = im.onerror = r; })))
  );
  try { await document.fonts.ready; } catch (e) { /* older engines */ }
  window.__printReady = true;
  // In a plain browser tab, hand the person the print dialog directly.
  const headless = navigator.webdriver || /HeadlessChrome/.test(navigator.userAgent);
  if (!navigator.userAgent.includes('Electron') && !headless) setTimeout(() => window.print(), 400);
}
if (location.hash.startsWith('#print/')) bootPrintMode(false);
else if (location.hash.startsWith('#printdeck/')) bootPrintMode(true);

$('pdfBtn').addEventListener('click', async () => {
  const note = state.current;
  if (!note) return;
  if (state.editing && state.dirty) {
    const updated = await api.save(note.file, await rawForSave($('editor').value));
    applySaved(updated);
  }
  const deckMode = isDeckNote(note);
  if (window.marknoteNative && window.marknoteNative.exportPdf) {
    alertBar('Creating PDF…');
    const res = await window.marknoteNative.exportPdf(note.file, deckMode, note.title);
    if (res && res.ok) alertBar('PDF saved: ' + res.path.split('/').pop());
    else if (res && res.error) alertBar('PDF export failed: ' + res.error);
  } else {
    // browser fallback: the print view opens and shows the print dialog
    window.open(location.origin + '/' + (deckMode ? '#printdeck/' : '#print/') + encodeURIComponent(note.file), '_blank');
  }
});

/* ——— ↑/↓ steps through the note list ——— */
// After picking a note in the sidebar, arrow keys walk the visible list
// (same order/filtering as shown). Inactive while editing, in overlays,
// or when focus sits in a field.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  if (!state.current || state.editing) return;
  if (deck || deckEd.open) return;
  if ($('noteView').hidden) return;
  if (!$('presenterView').hidden || !$('quickOpen').hidden || !$('mmModal').hidden || !$('todoSuggestModal').hidden) return;
  const t = document.activeElement;
  if (t && t.matches('input, textarea, select, [contenteditable="true"]')) return;
  const rows = [...document.querySelectorAll('#noteList .note-item')];
  if (!rows.length) return;
  const idx = rows.findIndex((r) => r.dataset.file === state.current.file);
  const next = rows[idx + (e.key === 'ArrowDown' ? 1 : -1)];
  if (!next) return;
  e.preventDefault();
  openNote(next.dataset.file);
  // openNote re-renders the list — scroll the FRESH active row into view
  const active = document.querySelector('#noteList .note-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
});

/* ——— text alignment blocks ——— */
// ::: center … ::: (also right/justify) becomes a wrapping div — markdown
// inside is processed normally since the markers travel through marked as
// HTML comments. Nesting is not supported.
function applyAlignBlocks(el) {
  let wrap = null;
  for (const node of [...el.childNodes]) {
    if (node.nodeType === Node.COMMENT_NODE) {
      const m = node.nodeValue.match(/^align:(center|right|justify)$/);
      if (m) {
        wrap = document.createElement('div');
        wrap.className = 'align-' + m[1];
        el.insertBefore(wrap, node);
        node.remove();
        continue;
      }
      if (node.nodeValue === '/align') {
        wrap = null;
        node.remove();
        continue;
      }
    }
    if (wrap) wrap.appendChild(node);
  }
}

// Toolbar: wrap the selected lines (or the current line) in an alignment
// block; same kind again — or the left button — unwraps. Undo-friendly via
// tbReplace.
function setAlignment(kind) {
  const box = tbb();
  const v = box.value;
  let bs = v.lastIndexOf('\n', box.selectionStart - 1) + 1;
  let be = v.indexOf('\n', box.selectionEnd);
  if (be === -1) be = v.length;
  let existing = null;
  const selfM = v.slice(bs, be).match(/^:::[ \t]*(center|right|justify)[ \t]*\n([\s\S]*?)\n:::[ \t]*$/);
  if (selfM) {
    existing = selfM[1];
  } else {
    // wrapper lines sitting just outside the selected block?
    const openM = v.slice(0, bs).match(/(^|\n)(:::[ \t]*(center|right|justify)[ \t]*\n)$/);
    const closeM = v.slice(be).match(/^(\n:::[ \t]*)(\n|$)/);
    if (openM && closeM) {
      existing = openM[3];
      bs -= openM[2].length;
      be += closeM[1].length;
    }
  }
  const inner = existing
    ? v.slice(bs, be).replace(/^:::[^\n]*\n/, '').replace(/\n:::[ \t]*$/, '')
    : v.slice(bs, be);
  const out = (!kind || existing === kind) ? inner : `::: ${kind}\n${inner}\n:::`;
  if (out === v.slice(bs, be)) return;
  tbReplace(bs, be, out);
  // keep the content selected so repeated clicks toggle/swap the same block
  const innerStart = bs + (out === inner ? 0 : out.indexOf('\n') + 1);
  box.setSelectionRange(innerStart, innerStart + inner.length);
}

toolbarActions.alignLeft = () => setAlignment(null);
toolbarActions.alignCenter = () => setAlignment('center');
toolbarActions.alignRight = () => setAlignment('right');

/* ——— backup: export/import everything as a zip ——— */
// For users who don't git-push their notes: Export writes notes/ +
// attachments/ as one zip; Import extracts one (overwriting same-named
// files) after the server snapshots the current state to .backups/.

$('backupBtn').addEventListener('click', () => {
  $('backupMenu').hidden = !$('backupMenu').hidden;
});
document.addEventListener('mousedown', (e) => {
  if (!$('backupMenu').hidden && !e.target.closest('#backupMenu, #backupBtn')) {
    $('backupMenu').hidden = true;
  }
});

$('backupExport').addEventListener('click', async () => {
  $('backupMenu').hidden = true;
  if (window.marknoteNative && window.marknoteNative.saveBackup) {
    alertBar('Creating backup zip…');
    const res = await window.marknoteNative.saveBackup();
    if (res && res.ok) alertBar(`Backup saved (${Math.round(res.size / 1024 / 1024)} MB)`);
    else if (res && res.error) alertBar('Backup failed: ' + res.error);
  } else {
    location.href = '/api/backup'; // browser: plain download
  }
});

const backupFile = document.createElement('input');
backupFile.type = 'file';
backupFile.accept = '.zip';
$('backupImport').addEventListener('click', () => {
  $('backupMenu').hidden = true;
  backupFile.click();
});
backupFile.addEventListener('change', async () => {
  const f = backupFile.files[0];
  backupFile.value = '';
  if (!f) return;
  alertBar('Importing backup…');
  try {
    const res = await fetch('/api/restore', { method: 'POST', body: f });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'import failed');
    state.notes = await api.list();
    renderTags();
    renderList();
    updateTodoCount();
    if (state.current && !state.notes.find((n) => n.file === state.current.file)) {
      state.current = null;
      $('noteView').hidden = true;
      $('empty').hidden = false;
    } else if (state.current) {
      openNote(state.current.file); // re-render possibly-updated content
    }
    alertBar(`Imported ${data.files} files — previous state saved in ${data.safety}`);
  } catch (err) {
    alertBar('Import failed: ' + String(err.message || err));
  }
});

/* ——— note templates ——— */
// templates/*.md — front-matter title is the display name; {{title}} and
// {{date}} in the body are filled in at creation. Tags copy over too.

let createTemplateFile = null;

let templateModalItems = [];

async function refreshTemplatePreview() {
  if (!createTemplateFile) return;
  const title = $('templateTitle').value.trim() || 'Titel';
  const { body } = await bodyFromTemplate(createTemplateFile, title);
  renderMarkdown($('templatePreview'), body, { staticMermaid: true });
  $('templatePreview').querySelectorAll('.transcribe-btn, .diagram-edit').forEach((el) => el.remove());
  await renderMermaidStatic($('templatePreview'));
}

function pickTemplate(file) {
  createTemplateFile = file;
  $('templatePickList').querySelectorAll('button').forEach((b2) =>
    b2.classList.toggle('active', b2.dataset.template === file));
  refreshTemplatePreview();
}

$('fromTemplateBtn').addEventListener('click', async () => {
  $('createMenu').hidden = true;
  templateModalItems = await fetch('/api/templates').then((r) => r.json()).catch(() => []);
  $('templatePickList').innerHTML = templateModalItems.length
    ? templateModalItems.map((t) => `<button data-template="${escapeHtml(t.file)}">${escapeHtml(t.title)}</button>`).join('')
    : '<div class="template-empty">No templates — add .md files to templates/</div>';
  $('templateTitle').value = '';
  $('templateCreate').disabled = true;
  $('templatePreview').innerHTML = '';
  $('templateModal').hidden = false;
  if (templateModalItems.length) pickTemplate(templateModalItems[0].file);
  $('templateTitle').focus();
});

$('templatePickList').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-template]');
  if (btn) pickTemplate(btn.dataset.template);
});
$('templateTitle').addEventListener('input', () => {
  $('templateCreate').disabled = !$('templateTitle').value.trim();
});
let templatePreviewTimer = null;
$('templateTitle').addEventListener('input', () => {
  clearTimeout(templatePreviewTimer);
  templatePreviewTimer = setTimeout(refreshTemplatePreview, 400);
});
$('templateCancel').addEventListener('click', () => { $('templateModal').hidden = true; });
$('templateTitle').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !$('templateCreate').disabled) $('templateCreate').click();
  if (e.key === 'Escape') $('templateModal').hidden = true;
});

$('templateCreate').addEventListener('click', async () => {
  const title = $('templateTitle').value.trim();
  if (!title || !createTemplateFile) return;
  $('templateModal').hidden = true;
  const { file } = await api.create(title);
  const { body, tags } = await bodyFromTemplate(createTemplateFile, title);
  let rawN = await api.raw(file);
  if (tags.length) rawN = setTagsInRaw(rawN, tags);
  const fmEnd = frontmatterEndIndex(rawN);
  await api.save(file, rawN.slice(0, fmEnd) + '\n' + body);
  state.notes = await api.list();
  renderTags();
  renderList();
  openNote(file);
  if (isDeckNote(state.current)) openDeckEditor();
  else enterEdit();
});

// ⋯ menu: turn the current note into a template
$('saveTemplateBtn').addEventListener('click', async () => {
  const note = state.current;
  if (!note || isLockedBody(note.body)) return;
  const slug = note.title.toLowerCase().replace(/[^a-z0-9åäö]+/gi, '-').replace(/^-|-$/g, '') || 'template';
  const tpl = `---\ntags: [${note.tags.map((t) => `'${t.replace(/'/g, "''")}'`).join(', ')}]\ntitle: '${note.title.replace(/'/g, "''")}'\n---\n\n` + note.body;
  await fetch('/api/templates/' + encodeURIComponent(slug + '.md'), { method: 'PUT', body: tpl });
  alertBar(`Saved as template: ${note.title}`);
});

async function bodyFromTemplate(file, title) {
  const raw = await fetch('/api/templates/' + encodeURIComponent(file)).then((r) => r.text());
  const { body, tags } = (() => {
    // reuse the server's front-matter shape client-side
    if (!raw.startsWith('---')) return { body: raw, tags: [] };
    const end = raw.indexOf('\n---', 3);
    if (end === -1) return { body: raw, tags: [] };
    const header = raw.slice(0, end);
    const tagsM = header.match(/^tags:\s*\[(.*)\]$/m);
    const tags2 = tagsM && tagsM[1].trim()
      ? tagsM[1].split(',').map((t) => t.trim().replace(/^'(.*)'$/, '$1')).filter(Boolean)
      : [];
    return { body: raw.slice(end + 4).replace(/^\r?\n/, ''), tags: tags2 };
  })();
  const today = todayStr();
  const filled = body
    .replaceAll('{{title}}', title)
    .replaceAll('{{date}}', today);
  return { body: filled, tags };
}

/* ——— markdown table editing: Tab walks cells, table auto-formats ——— */

function tableBlockAt(v, pos) {
  const isRow = (s) => /^\s*\|/.test(s);
  let lineStart = v.lastIndexOf('\n', pos - 1) + 1;
  let lineEnd = v.indexOf('\n', pos);
  if (lineEnd === -1) lineEnd = v.length;
  if (!isRow(v.slice(lineStart, lineEnd))) return null;
  let start = lineStart;
  while (start > 0) {
    const ps = v.lastIndexOf('\n', start - 2) + 1;
    if (!isRow(v.slice(ps, start - 1))) break;
    start = ps;
  }
  let end = lineEnd;
  while (end < v.length) {
    const ne = v.indexOf('\n', end + 1);
    const stop = ne === -1 ? v.length : ne;
    if (!isRow(v.slice(end + 1, stop))) break;
    end = stop;
  }
  return { start, end };
}

const tableCells = (line) => {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
};
const isSepCells = (cells) => cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c || '-'));

// Reformat a table block and return cell ranges for caret placement.
function formatTable(text) {
  const rows = text.split('\n').map(tableCells);
  const cols = Math.max(...rows.map((r) => r.length));
  rows.forEach((r) => { while (r.length < cols) r.push(isSepCells(r) ? '---' : ''); });
  const widths = [];
  for (let c = 0; c < cols; c++) {
    widths[c] = Math.max(3, ...rows.filter((r) => !isSepCells(r)).map((r) => (r[c] || '').length));
  }
  const sepIdx = rows.findIndex(isSepCells);
  const aligns = sepIdx !== -1
    ? rows[sepIdx].map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left'))
    : [];
  const ranges = [];
  const lines = rows.map((r, ri) => {
    const sep = isSepCells(r);
    let line = '|';
    const rowRanges = [];
    for (let c = 0; c < cols; c++) {
      const w = widths[c];
      let cell;
      if (sep) {
        const al = aligns[c] || 'left';
        cell = al === 'center' ? ':' + '-'.repeat(Math.max(1, w - 2)) + ':'
          : al === 'right' ? '-'.repeat(Math.max(1, w - 1)) + ':'
          : '-'.repeat(w);
      } else {
        cell = (r[c] || '').padEnd(w);
      }
      const cellStart = line.length + 1; // after '| '
      line += ' ' + cell + ' |';
      rowRanges.push({ start: cellStart, len: (sep ? cell : (r[c] || '')).length, sep });
    }
    ranges.push(rowRanges);
    return line;
  });
  // convert per-line ranges to absolute offsets within the block
  let off = 0;
  const abs = lines.map((line, i) => {
    const out = ranges[i].map((rr) => ({ start: off + rr.start, end: off + rr.start + rr.len, sep: rr.sep }));
    off += line.length + 1;
    return out;
  });
  return { text: lines.join('\n'), cells: abs };
}

function handleTableTab(box, shift) {
  if (typeof suggest === 'object' && suggest.open) return false;
  const v = box.value;
  const block = tableBlockAt(v, box.selectionStart);
  if (!block) return false;
  const before = v.slice(block.start, box.selectionStart);
  const rowIdx = before.split('\n').length - 1;
  const lineText = before.slice(before.lastIndexOf('\n') + 1);
  const cellIdx = Math.max(0, (lineText.match(/\|/g) || []).length - 1);
  const fmt = formatTable(v.slice(block.start, block.end));
  let r = rowIdx;
  let c = cellIdx + (shift ? -1 : 1);
  const cols = fmt.cells[0].length;
  while (true) {
    if (c >= cols) { r += 1; c = 0; }
    if (c < 0) { r -= 1; c = cols - 1; }
    if (r < 0) { r = 0; c = 0; break; }
    if (r >= fmt.cells.length) {
      // Tab past the last cell: append an empty row
      const empty = '|' + (' '.repeat(3) + ' |').repeat(cols);
      fmt.text += '\n' + empty;
      fmt.cells.push([...Array(cols)].map((_, i) => {
        const start = fmt.text.length - empty.length + 2 + i * 6;
        return { start, end: start, sep: false };
      }));
      break;
    }
    if (fmt.cells[r][c] && fmt.cells[r][c].sep) { c += shift ? -1 : 1; continue; }
    break;
  }
  tbReplace(block.start, block.end, fmt.text);
  const target = fmt.cells[r][Math.max(0, Math.min(c, cols - 1))];
  box.setSelectionRange(block.start + target.start, block.start + target.end);
  return true;
}

for (const boxEl of [ed, $('deckCode')]) {
  boxEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (handleTableTab(boxEl, e.shiftKey)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);
}

/* ——— locked notes: passphrase-encrypted bodies ——— */
// On disk the body becomes a marker line + base64(salt|iv|AES-GCM ciphertext),
// key derived with PBKDF2-SHA256 (310k rounds). Plaintext lives only in memory
// (unlockedNotes) while the app is open. Front matter stays readable so lists,
// tags and renames keep working.

const LOCK_MARK = '<!-- marknote:locked v1 -->';
const unlockedNotes = new Map(); // file → { pass, plain }

function isLockedBody(body) {
  return (body || '').trimStart().startsWith(LOCK_MARK);
}

async function lockKey(pass, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptBody(pass, plain) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await lockKey(pass, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain)));
  const blob = new Uint8Array(salt.length + iv.length + ct.length);
  blob.set(salt, 0);
  blob.set(iv, salt.length);
  blob.set(ct, salt.length + iv.length);
  let b64 = btoa(String.fromCharCode(...blob));
  b64 = b64.replace(/(.{76})/g, '$1\n'); // wrapped lines keep git diffs sane
  return LOCK_MARK + '\n' + b64;
}

async function decryptBody(pass, body) {
  const b64 = body.trim().slice(LOCK_MARK.length).replace(/\s+/g, '');
  const blob = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const key = await lockKey(pass, blob.slice(0, 16));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.slice(16, 28) }, key, blob.slice(28));
  return new TextDecoder().decode(pt);
}

// Editor saves route through this: locked notes are re-encrypted before PUT.
async function rawForSave(text) {
  if (!state.current || !isLockedBody(state.current.body)) return text;
  const u = unlockedNotes.get(state.current.file);
  if (!u) throw new Error('note is locked');
  const fmEnd = frontmatterEndIndex(text);
  const plain = text.slice(fmEnd).replace(/^\r?\n/, '');
  const enc = await encryptBody(u.pass, plain);
  unlockedNotes.set(state.current.file, { pass: u.pass, plain });
  return text.slice(0, fmEnd) + '\n' + enc + '\n';
}

function renderNoteBody(note) {
  if (isLockedBody(note.body)) {
    const u = unlockedNotes.get(note.file);
    if (u) {
      renderMarkdown($('rendered'), u.plain);
      return;
    }
    $('rendered').innerHTML = `
      <div class="lock-panel">
        <div class="lock-glyph">🔒</div>
        <div class="lock-title">This note is locked</div>
        <div class="lock-row">
          <input type="password" class="lock-pass" placeholder="Passphrase" autocomplete="current-password">
          <button class="btn-accent lock-unlock">Unlock</button>
        </div>
        <div class="lock-error" hidden></div>
      </div>`;
    return;
  }
  renderMarkdown($('rendered'), note.body);
}

function updateLockMenu(note) {
  const locked = isLockedBody(note.body);
  const cached = locked && unlockedNotes.has(note.file);
  $('lockBtn').hidden = locked && !cached;
  $('lockBtn').textContent = locked ? 'Lock again' : 'Lock note…';
  $('removeLockBtn').hidden = !cached;
}

async function tryUnlock() {
  const panel = $('rendered').querySelector('.lock-panel');
  if (!panel || !state.current) return;
  const pass = panel.querySelector('.lock-pass').value;
  const err = panel.querySelector('.lock-error');
  if (!pass) return;
  try {
    const plain = await decryptBody(pass, state.current.body);
    unlockedNotes.set(state.current.file, { pass, plain });
    scheduleAutoLock(state.current.file);
    renderNoteBody(state.current);
    updateLockMenu(state.current);
  } catch (e) {
    err.textContent = 'Wrong passphrase.';
    err.hidden = false;
    panel.querySelector('.lock-pass').select();
  }
}

$('rendered').addEventListener('click', (e) => {
  if (e.target.closest('.lock-unlock')) tryUnlock();
});
$('rendered').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.closest('.lock-pass')) tryUnlock();
});

/* lock modal (choosing a passphrase) */
function openLockModal() {
  $('lockPass1').value = '';
  $('lockPass2').value = '';
  $('lockError').hidden = true;
  $('lockModal').hidden = false;
  $('lockPass1').focus();
}
$('lockCancel').addEventListener('click', () => { $('lockModal').hidden = true; });
$('lockConfirm').addEventListener('click', async () => {
  const p1 = $('lockPass1').value;
  const p2 = $('lockPass2').value;
  const err = $('lockError');
  if (p1.length < 4) { err.textContent = 'At least 4 characters.'; err.hidden = false; return; }
  if (p1 !== p2) { err.textContent = 'Passphrases differ.'; err.hidden = false; return; }
  $('lockModal').hidden = true;
  const note = state.current;
  if (state.editing) await exitEdit({ save: true });
  const rawText = await api.raw(note.file);
  const fmEnd = frontmatterEndIndex(rawText);
  const plain = rawText.slice(fmEnd).replace(/^\r?\n/, '');
  const enc = await encryptBody(p1, plain);
  const updated = await api.save(note.file, rawText.slice(0, fmEnd) + '\n' + enc + '\n');
  unlockedNotes.set(note.file, { pass: p1, plain });
  scheduleAutoLock(note.file);
  applySaved(updated);
  renderNoteBody(state.current);
  updateLockMenu(state.current);
  renderList();
  alertBar('Note locked 🔒');
});

$('lockBtn').addEventListener('click', () => {
  const note = state.current;
  if (!note) return;
  if (isLockedBody(note.body)) {
    // "Lock again" — forget the key for this session
    unlockedNotes.delete(note.file);
    renderNoteBody(note);
    updateLockMenu(note);
  } else {
    openLockModal();
  }
});

$('removeLockBtn').addEventListener('click', async () => {
  const note = state.current;
  const u = note && unlockedNotes.get(note.file);
  if (!u) return;
  const rawText = await api.raw(note.file);
  const fmEnd = frontmatterEndIndex(rawText);
  const updated = await api.save(note.file, rawText.slice(0, fmEnd) + '\n' + u.plain);
  unlockedNotes.delete(note.file);
  applySaved(updated);
  renderNoteBody(state.current);
  updateLockMenu(state.current);
  renderList();
  alertBar('Lock removed');
});

/* auto-lock: forget cached passphrases after idle */
const AUTO_LOCK_MS = 2 * 60 * 1000;
const lockTimers = new Map();
let pendingRelock = null;

function scheduleAutoLock(file) {
  clearTimeout(lockTimers.get(file));
  lockTimers.set(file, setTimeout(() => autoLock(file), AUTO_LOCK_MS));
}

function autoLock(file) {
  clearTimeout(lockTimers.get(file));
  lockTimers.delete(file);
  if (!unlockedNotes.has(file)) return;
  // never yank an open editor — relock when editing ends instead
  if (state.current && state.current.file === file && state.editing) {
    pendingRelock = file;
    return;
  }
  unlockedNotes.delete(file);
  if (state.current && state.current.file === file) {
    renderNoteBody(state.current);
    updateLockMenu(state.current);
  }
}

// any interaction while the unlocked note is open counts as activity
for (const ev of ['keydown', 'pointerdown', 'wheel']) {
  document.addEventListener(ev, () => {
    if (state.current && unlockedNotes.has(state.current.file)) {
      scheduleAutoLock(state.current.file);
    }
  }, { passive: true });
}
