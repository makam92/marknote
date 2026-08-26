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
    .replace(/\]\(\/attachments\/([^)\n]+)\)/g, (m, p1) => '](/attachments/' + p1.replace(/ /g, '%20') + ')');
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
    if (!yt && !vimeo && !isFile && !isAudio) return;

    let embed;
    if (isAudio) {
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

function renderMarkdown(el, body) {
  // breaks: true — a single newline renders as a line break, like Notable did.
  el.innerHTML = marked.parse(preprocess(body), { gfm: true, breaks: true });
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
  const diagrams = el.querySelectorAll('.mermaid');
  if (diagrams.length) mermaid.run({ nodes: diagrams }).catch(() => {});
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
  $('pinBtn').textContent = updated.pinned ? 'Unpin' : 'Pin';
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
  $('renameWrap').hidden = true;
  $('editorWrap').hidden = true;
  $('rendered').hidden = false;
  $('pinBtn').textContent = note.pinned ? 'Unpin' : 'Pin';
  closeFind();
  renderBacklinks(note);
  $('editBtn').textContent = 'Edit';
  resetDelete();
  $('noteDate').textContent = formatDate(note.modified);
  renderHeaderTags(note);
  renderMarkdown($('rendered'), note.body);
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
    const updated = await api.save(state.current.file, $('editor').value);
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
  renderMarkdown($('rendered'), state.current.body);
  renderBacklinks(state.current);
}

async function saveEditor() {
  if (!state.editing || !state.dirty) return;
  const updated = await api.save(state.current.file, $('editor').value);
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

// Wrap the selection (or a placeholder) in inline markers, e.g. **bold**.
function wrapSel(before, after, placeholder) {
  const s = ed.selectionStart;
  const e = ed.selectionEnd;
  const sel = ed.value.slice(s, e) || placeholder;
  edReplace(s, e, before + sel + after);
  ed.setSelectionRange(s + before.length, s + before.length + sel.length);
  setDirty(true);
}

// Prefix every selected line (heading, list, quote). Applying the same prefix
// again removes it; applying a different one replaces the existing marker.
function prefixLines(prefix, opts = {}) {
  const value = ed.value;
  const lineStart = value.lastIndexOf('\n', ed.selectionStart - 1) + 1;
  let lineEnd = value.indexOf('\n', ed.selectionEnd);
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
  edReplace(lineStart, lineEnd, next);
  ed.setSelectionRange(lineStart, lineStart + next.length);
  setDirty(true);
}

// Insert a block template at the cursor with a blank line before it,
// selecting [selFrom, selTo) within the block so typing replaces the placeholder.
function insertBlock(block, selFrom, selTo) {
  const s = ed.selectionStart;
  const before = ed.value.slice(0, s);
  const pad = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  edReplace(s, ed.selectionEnd, pad + block);
  const base = s + pad.length;
  ed.setSelectionRange(base + selFrom, base + (selTo ?? selFrom));
  setDirty(true);
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
    const s = ed.selectionStart;
    const sel = ed.value.slice(s, ed.selectionEnd);
    if (sel) {
      const before = ed.value.slice(0, s);
      const pad = !before || before.endsWith('\n') ? '' : '\n';
      edReplace(s, ed.selectionEnd, pad + '```\n' + sel.replace(/\n$/, '') + '\n```\n');
      const langPos = s + pad.length + 3; // right after ``` so a language can be typed
      ed.setSelectionRange(langPos, langPos);
      setDirty(true);
    } else {
      insertBlock('```\ncode here\n```\n', 4, 13);
    }
  },
  mermaid: () => {
    const fence = fenceAtCursor();
    if (fence) {
      openMermaid(fence.code, 'Save', (code) => {
        edReplace(fence.start, fence.end, code);
        setDirty(true);
      });
    } else {
      openMermaid(MERMAID_TEMPLATES.flowchart, 'Insert', (code) => {
        insertBlock('```mermaid\n' + code + '\n```\n', 11 + code.length + 5);
        setDirty(true);
      });
    }
  },
  notelink: () => {
    const s = ed.selectionStart;
    const sel = ed.value.slice(s, ed.selectionEnd);
    ed.setRangeText('[[' + sel + ']]', s, ed.selectionEnd);
    ed.setSelectionRange(s + 2 + sel.length, s + 2 + sel.length);
    ed.focus();
    setDirty(true);
    updateSuggest();
  },
  link: () => {
    const s = ed.selectionStart;
    const sel = ed.value.slice(s, ed.selectionEnd);
    const label = sel || 'text';
    edReplace(s, ed.selectionEnd, '[' + label + '](url)');
    const urlStart = s + label.length + 3;
    if (sel) ed.setSelectionRange(urlStart, urlStart + 3);
    else ed.setSelectionRange(s + 1, s + 1 + label.length);
    setDirty(true);
  },
  table: () => {
    const t = '| Column 1 | Column 2 |\n| -------- | -------- |\n|          |          |\n';
    insertBlock(t, 2, 10);
  },
  image: () => {
    const s = ed.selectionStart;
    const alt = ed.value.slice(s, ed.selectionEnd) || 'alt';
    edReplace(s, ed.selectionEnd, '![' + alt + '](@attachment/file.png)');
    const nameStart = s + alt.length + 4 + '@attachment/'.length;
    ed.setSelectionRange(nameStart, nameStart + 'file.png'.length);
    setDirty(true);
  }
};

/* ——— [[ note-link autocomplete ——— */

let suggest = { open: false, items: [], index: 0, start: 0 };

// Caret position in viewport coordinates, via an offscreen mirror of the textarea.
function caretViewportPos() {
  const style = getComputedStyle(ed);
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
  mirror.style.width = ed.clientWidth + 'px';
  mirror.textContent = ed.value.slice(0, ed.selectionStart);
  const marker = document.createElement('span');
  marker.textContent = '​';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const top = marker.offsetTop;
  const left = marker.offsetLeft;
  mirror.remove();
  const rect = ed.getBoundingClientRect();
  return {
    top: rect.top + top - ed.scrollTop + (parseFloat(style.lineHeight) || 22),
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
  const pos = caretViewportPos();
  panel.hidden = false;
  panel.style.left = Math.max(8, Math.min(pos.left, window.innerWidth - panel.offsetWidth - 8)) + 'px';
  panel.style.top = Math.min(pos.top + 4, window.innerHeight - panel.offsetHeight - 8) + 'px';
}

function updateSuggest() {
  if (!state.editing) return closeSuggest();
  const caret = ed.selectionStart;
  if (caret !== ed.selectionEnd) return closeSuggest();
  const m = ed.value.slice(0, caret).match(/\[\[([^\][\n]*)$/);
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
  suggest = { open: true, items, index: 0, start: caret - m[1].length };
  renderSuggest();
}

function acceptSuggest(note) {
  const caret = ed.selectionStart;
  // Swallow a closing ]] that's already there (e.g. from the toolbar button).
  const trailing = ed.value.slice(caret, caret + 2) === ']]' ? 2 : 0;
  edReplace(suggest.start, caret + trailing, note.title + ']]');
  closeSuggest();
  setDirty(true);
}

$('noteSuggest').addEventListener('mousedown', (e) => e.preventDefault());
$('noteSuggest').addEventListener('click', (e) => {
  const btn = e.target.closest('.suggest-item');
  if (btn) acceptSuggest(suggest.items[Number(btn.dataset.i)]);
});

ed.addEventListener('input', updateSuggest);
ed.addEventListener('click', updateSuggest);
ed.addEventListener('blur', closeSuggest);
ed.addEventListener('scroll', closeSuggest);
window.addEventListener('resize', closeSuggest);

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
function fenceAtCursor() {
  const pos = ed.selectionStart;
  for (const m of ed.value.matchAll(MM_FENCE)) {
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
  $('recBtn').hidden = true;
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
  $('recBtn').hidden = false;
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

$('recBtn').addEventListener('click', startMeeting);
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
  emojiCaret = { s: ed.selectionStart, e: ed.selectionEnd };
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
  ed.focus();
}

function pickEmoji(ch) {
  closeEmoji();
  edReplace(emojiCaret.s, emojiCaret.e, ch);
  rememberEmoji(ch);
  setDirty(true);
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

/* ——— paste / drop attachments into the editor ——— */

async function insertAttachment(blob, nameHint) {
  const { file } = await api.upload(blob, nameHint);
  const isImage = /\.(png|jpe?g|gif|webp|svg)$/i.test(file);
  const md = isImage ? `![](@attachment/${file})` : `[${file}](@attachment/${file})`;
  edReplace(ed.selectionStart, ed.selectionEnd, md + '\n');
  setDirty(true);
}

ed.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.items || [])]
    .filter((i) => i.kind === 'file')
    .map((i) => i.getAsFile())
    .filter(Boolean);
  if (!files.length) return;
  e.preventDefault();
  (async () => {
    // Chrome names clipboard screenshots "image.png" — let the server pick a dated name.
    for (const f of files) await insertAttachment(f, f.name === 'image.png' ? '' : f.name);
  })();
});

ed.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
});
ed.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  (async () => {
    for (const f of files) await insertAttachment(f, f.name);
  })();
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
// except inside the emoji panel, whose search input needs focus itself.
$('editorToolbar').addEventListener('mousedown', (e) => {
  if (!e.target.closest('#emojiPanel')) e.preventDefault();
});
$('editorToolbar').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-md]');
  if (btn && toolbarActions[btn.dataset.md]) toolbarActions[btn.dataset.md]();
});

ed.addEventListener('keydown', (e) => {
  if (suggest.open) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const len = suggest.items.length;
      suggest.index = (suggest.index + (e.key === 'ArrowDown' ? 1 : len - 1)) % len;
      renderSuggest();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      acceptSuggest(suggest.items[suggest.index]);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSuggest();
      return;
    }
  }
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

$('newNote').addEventListener('click', () => {
  const form = $('newNoteForm');
  form.hidden = !form.hidden;
  if (!form.hidden) $('newNoteTitle').focus();
});

$('newNoteTitle').addEventListener('keydown', async (e) => {
  if (e.key === 'Escape') {
    $('newNoteForm').hidden = true;
  } else if (e.key === 'Enter') {
    const title = $('newNoteTitle').value.trim();
    if (!title) return;
    const { file } = await api.create(title);
    state.notes = await api.list();
    $('newNoteTitle').value = '';
    $('newNoteForm').hidden = true;
    renderTags();
    renderList();
    openNote(file);
    enterEdit();
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
