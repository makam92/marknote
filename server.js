// Minimal zero-dependency note server.
// Serves the web UI from ./public, notes from ./notes, images from ./attachments.
// Deleted notes are moved to ./.trash, never removed from disk.

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');

const ROOT = __dirname; // code root (public/, vendored libs)
// Data lives next to the code in repo/dev mode, but in ~/Documents/Marknote
// when running from a bundled .app (the bundle must stay read-only).
const BUNDLED = __dirname.includes('.app/Contents/Resources');
const DATA_ROOT = process.env.MARKNOTE_DATA
  || (BUNDLED ? path.join(os.homedir(), 'Documents', 'Marknote') : ROOT);
const NOTES_DIR = path.join(DATA_ROOT, 'notes');
const ATTACH_DIR = path.join(DATA_ROOT, 'attachments');
const TRASH_DIR = path.join(DATA_ROOT, '.trash');
const PUBLIC_DIR = path.join(ROOT, 'public');
const TEMPLATES_DIR = path.join(DATA_ROOT, 'templates');
const PORT = Number(process.env.PORT) || 4747;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.weba': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json'
};

// GUI apps get a minimal PATH — resolve helper binaries by absolute path.
function findBin(candidates) {
  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* keep looking */ }
  }
  return null;
}

const WHISPER_BIN = findBin(['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli']);
const FFMPEG_BIN = findBin(['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']);
const BLENDER_BIN = findBin(['/Applications/Blender.app/Contents/MacOS/Blender', '/opt/homebrew/bin/blender']);
const WHISPER_MODEL = fs.existsSync(path.join(DATA_ROOT, 'models', 'ggml-small.bin'))
  ? path.join(DATA_ROOT, 'models', 'ggml-small.bin')
  : path.join(ROOT, 'models', 'ggml-small.bin');
const CLAUDE_BIN = findBin([
  path.join(os.homedir(), '.local/bin/claude'),
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude'
]);

// Filenames arrive URL-decoded; anything that could escape the notes dir is rejected.
function safeName(name) {
  if (!name || name !== path.basename(name) || name.startsWith('.') || name.includes('..')) return null;
  return name;
}

function parseFrontmatter(raw) {
  const meta = { title: null, tags: [], created: null, modified: null, pinned: null };
  if (!raw.startsWith('---')) return { meta, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { meta, body: raw };
  const header = raw.slice(raw.indexOf('\n') + 1, end);
  const body = raw.slice(end + 4).replace(/^\r?\n/, '');
  for (const line of header.split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (key === 'tags') {
      const list = value.match(/^\[(.*)\]$/);
      meta.tags = list && list[1].trim()
        ? list[1].split(',').map((t) => unquote(t.trim())).filter(Boolean)
        : [];
    } else if (key in meta) {
      meta[key] = unquote(value);
    }
  }
  return { meta, body };
}

function unquote(value) {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

// Keep Notable's `modified:` field truthful when a note is saved.
function touchModified(raw, iso) {
  if (!raw.startsWith('---')) return raw;
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return raw;
  const header = raw.slice(0, end);
  if (!/^modified:/m.test(header)) return raw;
  return header.replace(/^modified:.*$/m, `modified: '${iso}'`) + raw.slice(end);
}

function noteFromRaw(file, raw, stat) {
  const { meta, body } = parseFrontmatter(raw);
  return {
    file,
    title: meta.title || file.replace(/\.md$/, ''),
    tags: meta.tags,
    pinned: meta.pinned === 'true',
    created: meta.created || stat.birthtime.toISOString(),
    modified: meta.modified || stat.mtime.toISOString(),
    body
  };
}

async function listNotes() {
  const files = await fsp.readdir(NOTES_DIR);
  const notes = [];
  for (const file of files) {
    if (!file.endsWith('.md') || file.startsWith('.')) continue;
    const full = path.join(NOTES_DIR, file);
    const [raw, stat] = await Promise.all([fsp.readFile(full, 'utf8'), fsp.stat(full)]);
    notes.push(noteFromRaw(file, raw, stat));
  }
  return notes;
}

const fileExists = (p) => fsp.access(p).then(() => true, () => false);

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function setTitleInRaw(raw, title) {
  const line = `title: '${title.replace(/'/g, "''")}'`;
  if (raw.startsWith('---')) {
    const end = raw.indexOf('\n---', 3);
    if (end !== -1) {
      const headerStart = raw.indexOf('\n') + 1;
      let header = raw.slice(headerStart, end);
      header = /^title:/m.test(header)
        ? header.replace(/^title:.*$/m, line)
        : line + '\n' + header;
      return raw.slice(0, headerStart) + header + raw.slice(end);
    }
  }
  return `---\n${line}\n---\n\n` + raw;
}

function readBodyBuffer(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const readBody = (req) => readBodyBuffer(req).then((b) => b.toString('utf8'));

function send(res, status, data, type = 'application/json; charset=utf-8') {
  const payload = type.startsWith('application/json') ? JSON.stringify(data) : data;
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(payload);
}

// Streams files and honours Range requests so <video> can seek.
async function serveStatic(res, baseDir, relPath, range) {
  const full = path.normalize(path.join(baseDir, relPath));
  if (!full.startsWith(baseDir + path.sep) && full !== baseDir) {
    return send(res, 403, { error: 'forbidden' });
  }
  let stat;
  try {
    stat = await fsp.stat(full);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    return send(res, 404, { error: 'not found' });
  }
  const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';

  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  const m = range && range.match(/^bytes=(\d*)-(\d*)$/);
  if (m && (m[1] || m[2])) {
    if (m[1]) {
      start = parseInt(m[1], 10);
      if (m[2]) end = Math.min(parseInt(m[2], 10), end);
    } else {
      start = Math.max(0, stat.size - parseInt(m[2], 10));
    }
    if (start >= stat.size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    status = 206;
  }

  const headers = {
    'Content-Type': type,
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes'
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  res.writeHead(status, headers);
  const stream = fs.createReadStream(full, { start, end });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

function parseSegments(stdout) {
  const segs = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(
      /^\[(\d{2}):(\d{2}):(\d{2})[.,](\d{3}) +--> +(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\]\s*(.*)$/
    );
    if (!m) continue;
    const text = m[9].trim();
    if (!text) continue;
    segs.push({
      start: +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000,
      end: +m[5] * 3600 + +m[6] * 60 + +m[7] + +m[8] / 1000,
      text
    });
  }
  return segs;
}

function stampSeconds(secF) {
  const sec = Math.floor(secF);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

// Speaker turns via Claude: it spots speaker changes from conversational
// cues far better than pause timing can. Strictly regroup-and-label — the
// words themselves must survive verbatim.
async function attributeSpeakers(segs) {
  const input = segs.map((s) => `[${stampSeconds(s.start)}] ${s.text}`).join('\n');
  const prompt =
    'Below is an automatic speech transcript as timestamped fragments, in spoken order. ' +
    'Rewrite it as speaker turns. STRICT RULES: ' +
    '1) Reproduce the spoken words EXACTLY as given — never paraphrase, correct, translate, add or omit anything. ' +
    '2) Start a new turn when the speaker changes, inferred from conversational cues (greetings, questions vs answers, names, first-person shifts). ' +
    '3) Label speakers Speaker 1, Speaker 2, … consistently; if a speaker\'s real name is evident from the conversation, use the name instead. ' +
    '4) One line per turn, formatted exactly: - **<timestamp of the turn\'s first fragment>** <Speaker>: "<text>" ' +
    '5) Output only these lines — no preamble, no commentary.';
  const out = await new Promise((resolve, reject) => {
    const child = execFile(
      CLAUDE_BIN,
      ['-p', prompt],
      { timeout: 600 * 1000, maxBuffer: 32 * 1024 * 1024, cwd: os.tmpdir() },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
    child.stdin.write(input);
    child.stdin.end();
  });
  const text = out.trim().replace(/\*\*\[([^\]]+)\]\*\*/g, '**$1**');
  const inputChars = segs.reduce((a, s) => a + s.text.length, 0);
  // Sanity: refuse suspicious rewrites and fall back to pause-based turns.
  if (!text.startsWith('- ') || text.length < inputChars * 0.5) {
    throw new Error('attribution output failed sanity check');
  }
  return text;
}

// Fallback formatting: fold segments into turns at audio pauses
// (ffmpeg silencedetect), each line as  - **12:34** "…"
function formatTranscript(stdout, silences = []) {
  const segs = parseSegments(stdout);
  if (!segs.length) return stdout.trim();
  const turns = [];
  let cur = null;
  for (const s of segs) {
    // Whisper pads segment ends, so gaps come from the audio itself: a new
    // turn starts when this segment begins right after a detected silence.
    const afterPause = silences.some((se) => Math.abs(se - s.start) <= 0.7);
    if (!cur || afterPause) {
      cur = { start: s.start, parts: [] };
      turns.push(cur);
    }
    cur.parts.push(s.text);
  }
  return turns.map((t) => `- **${stampSeconds(t.start)}** "${t.parts.join(' ')}"`).join('\n');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    // What optional helpers are installed? The UI uses this to show friendly
    // setup guidance instead of raw errors.
    if (pathname === '/api/capabilities' && req.method === 'GET') {
      return send(res, 200, {
        whisper: !!WHISPER_BIN,
        whisperModel: await fileExists(WHISPER_MODEL),
        ffmpeg: !!FFMPEG_BIN,
        claude: !!CLAUDE_BIN,
        blender: !!BLENDER_BIN,
        dataRoot: DATA_ROOT
      });
    }

    // Download a media URL into attachments (for "Analyze recording" — e.g.
    // a direct link to an mp4/m4a). Auth-walled links (Teams/SharePoint) won't
    // work; download the file first in that case.
    if (pathname === '/api/fetch-media' && req.method === 'POST') {
      const { url: mediaUrl } = JSON.parse(await readBody(req) || '{}');
      let parsed;
      try { parsed = new URL(mediaUrl); } catch { return send(res, 400, { error: 'bad url' }); }
      if (!/^https?:$/.test(parsed.protocol)) return send(res, 400, { error: 'only http(s) urls' });
      let name = decodeURIComponent(parsed.pathname.split('/').pop() || '')
        .replace(/[<>:"|?*]/g, '').trim().replace(/[\s()]+/g, '-');
      if (!name || name.startsWith('.')) name = 'recording-' + Date.now();
      const tmp = path.join(os.tmpdir(), `marknote-media-${Date.now()}`);
      try {
        await new Promise((resolve, reject) => {
          execFile('/usr/bin/curl', ['-fsSL', '--max-time', '600', '--max-filesize', '2147483648', '-o', tmp, mediaUrl],
            { maxBuffer: 1024 * 1024 },
            (err) => (err ? reject(new Error('download failed')) : resolve()));
        });
        const stat = await fsp.stat(tmp);
        if (!stat.size) throw new Error('empty download');
        if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += '.mp4'; // best-effort extension
        // avoid overwriting an existing attachment
        let final = name;
        let i = 1;
        while (await fileExists(path.join(ATTACH_DIR, final))) {
          final = name.replace(/(\.[^.]*)$/, `-${++i}$1`);
        }
        await fsp.mkdir(ATTACH_DIR, { recursive: true });
        await fsp.rename(tmp, path.join(ATTACH_DIR, final));
        return send(res, 200, { file: final, size: stat.size });
      } catch (err) {
        fsp.unlink(tmp).catch(() => {});
        return send(res, 500, { error: String(err.message).slice(0, 200) });
      }
    }

    // Note templates: plain .md files in templates/ (front-matter title = name).
    if (pathname === '/api/templates' && req.method === 'GET') {
      await fsp.mkdir(TEMPLATES_DIR, { recursive: true });
      const files = (await fsp.readdir(TEMPLATES_DIR)).filter((f) => f.endsWith('.md') && !f.startsWith('.'));
      const out = [];
      for (const file of files) {
        const [txt, stat] = await Promise.all([
          fsp.readFile(path.join(TEMPLATES_DIR, file), 'utf8'),
          fsp.stat(path.join(TEMPLATES_DIR, file))
        ]);
        const { meta } = parseFrontmatter(txt);
        out.push({ file, title: meta.title || file.replace(/\.md$/, ''), tags: meta.tags });
      }
      out.sort((a2, b2) => a2.title.localeCompare(b2.title, 'sv'));
      return send(res, 200, out);
    }
    if (pathname.startsWith('/api/templates/') && req.method === 'GET') {
      const file = safeName(pathname.slice('/api/templates/'.length).normalize('NFC'));
      if (!file) return send(res, 400, { error: 'bad filename' });
      try {
        return send(res, 200, await fsp.readFile(path.join(TEMPLATES_DIR, file), 'utf8'), 'text/markdown; charset=utf-8');
      } catch {
        return send(res, 404, { error: 'template not found' });
      }
    }
    if (pathname.startsWith('/api/templates/') && req.method === 'PUT') {
      const file = safeName(pathname.slice('/api/templates/'.length).normalize('NFC'));
      if (!file || !file.endsWith('.md')) return send(res, 400, { error: 'bad filename' });
      await fsp.mkdir(TEMPLATES_DIR, { recursive: true });
      await fsp.writeFile(path.join(TEMPLATES_DIR, file), await readBody(req));
      return send(res, 200, { ok: true, file });
    }

    // Full backup: a zip of notes/ + attachments/, streamed straight from
    // macOS's zip. For users who don't git-push their notes.
    if (pathname === '/api/backup' && req.method === 'GET') {
      // macOS's zip can't stream to stdout — write a temp zip, stream the file
      const stamp = new Date().toISOString().slice(0, 10);
      const tmp = path.join(os.tmpdir(), `marknote-backup-${Date.now()}.zip`);
      await new Promise((resolve, reject) => {
        execFile('/usr/bin/zip', ['-r', '-q', tmp, 'notes', 'attachments', 'templates', '-x', '*.DS_Store'],
          { cwd: DATA_ROOT, maxBuffer: 1024 * 1024 },
          (err) => (err ? reject(err) : resolve()));
      }).catch((err) => { throw new Error('zip failed: ' + err.message); });
      const size = (await fsp.stat(tmp)).size;
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': size,
        'Content-Disposition': `attachment; filename="Marknote backup ${stamp}.zip"`
      });
      const stream = fs.createReadStream(tmp);
      stream.pipe(res);
      stream.on('close', () => fsp.unlink(tmp).catch(() => {}));
      return;
    }

    // Restore a backup zip: safety-snapshot the current state first, then
    // extract (overwrite) — only notes/* and attachments/* paths are accepted.
    if (pathname === '/api/restore' && req.method === 'POST') {
      const body = await readBodyBuffer(req, 2 * 1024 * 1024 * 1024);
      if (!body.length) return send(res, 400, { error: 'empty upload' });
      const tmp = path.join(os.tmpdir(), `marknote-restore-${Date.now()}.zip`);
      await fsp.writeFile(tmp, body);
      const run = (cmd, args, opts) => new Promise((resolve, reject) => {
        execFile(cmd, args, opts, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(stdout)));
      });
      try {
        // does the zip contain anything we accept?
        const listing = await run('/usr/bin/unzip', ['-Z1', tmp]).catch(() => '');
        const wanted = listing.split('\n').filter((l) => /^(notes|attachments|templates)\//.test(l) && !l.endsWith('/'));
        if (!wanted.length) return send(res, 400, { error: 'zip contains no notes/ or attachments/' });
        const backups = path.join(DATA_ROOT, '.backups');
        await fsp.mkdir(backups, { recursive: true });
        const safety = `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
        await run('/usr/bin/zip', ['-r', '-q', path.join(backups, safety), 'notes', 'attachments', 'templates', '-x', '*.DS_Store'], { cwd: DATA_ROOT });
        // exit code 11 = nothing matched, already excluded above; -o overwrites
        await run('/usr/bin/unzip', ['-o', '-q', tmp, 'notes/*', 'attachments/*', 'templates/*', '-d', DATA_ROOT]);
        return send(res, 200, { ok: true, files: wanted.length, safety: '.backups/' + safety });
      } catch (err) {
        console.error('restore:', err.message);
        return send(res, 500, { error: 'restore failed: ' + String(err.message).slice(0, 200) });
      } finally {
        fsp.unlink(tmp).catch(() => {});
      }
    }

    if (pathname === '/api/notes' && req.method === 'GET') {
      return send(res, 200, await listNotes());
    }

    if (pathname === '/api/notes' && req.method === 'POST') {
      const { title } = JSON.parse(await readBody(req) || '{}');
      const clean = (title || 'Untitled').replace(/[/\\:]/g, '-').trim() || 'Untitled';
      let file = `${clean}.md`;
      let counter = 2;
      while (await fsp.access(path.join(NOTES_DIR, file)).then(() => true, () => false)) {
        file = `${clean} ${counter++}.md`;
      }
      const now = new Date().toISOString();
      const escaped = clean.replace(/'/g, "''");
      const content = `---\ntitle: '${escaped}'\ncreated: '${now}'\nmodified: '${now}'\n---\n\n# ${clean}\n\n`;
      await fsp.writeFile(path.join(NOTES_DIR, file), content, 'utf8');
      return send(res, 201, { file });
    }

    if (pathname === '/api/rename' && req.method === 'POST') {
      const { file: oldFile, title } = JSON.parse(await readBody(req) || '{}');
      const safe = safeName(oldFile);
      if (!safe || !safe.endsWith('.md')) return send(res, 400, { error: 'bad filename' });
      const clean = (title || '').replace(/[/\\:]/g, '-').trim();
      if (!clean) return send(res, 400, { error: 'empty title' });

      const oldPath = path.join(NOTES_DIR, safe);
      const raw = await fsp.readFile(oldPath, 'utf8');
      const oldTitle = parseFrontmatter(raw).meta.title || safe.replace(/\.md$/, '');

      let newFile = `${clean}.md`;
      let counter = 2;
      while (newFile !== safe && (await fileExists(path.join(NOTES_DIR, newFile)))) {
        newFile = `${clean} ${counter++}.md`;
      }

      let updated = setTitleInRaw(raw, clean);
      // If the body's first heading is the old title, rename it too.
      updated = updated.replace(new RegExp('^# ' + escapeRegExp(oldTitle) + '[ \\t]*$', 'm'), '# ' + clean);
      await fsp.writeFile(path.join(NOTES_DIR, newFile), updated, 'utf8');
      if (newFile !== safe) await fsp.unlink(oldPath);

      // Point [[wiki links]] and @note/ references in other notes at the new name.
      let linkUpdates = 0;
      const wikiRe = new RegExp('\\[\\[\\s*' + escapeRegExp(oldTitle) + '\\s*\\]\\]', 'gi');
      for (const f of await fsp.readdir(NOTES_DIR)) {
        if (!f.endsWith('.md') || f.startsWith('.') || f === newFile) continue;
        const p = path.join(NOTES_DIR, f);
        const content = await fsp.readFile(p, 'utf8');
        const next = content.replace(wikiRe, '[[' + clean + ']]').split('@note/' + safe).join('@note/' + newFile);
        if (next !== content) {
          await fsp.writeFile(p, next, 'utf8');
          linkUpdates++;
        }
      }

      const stat = await fsp.stat(path.join(NOTES_DIR, newFile));
      return send(res, 200, { ...noteFromRaw(newFile, updated, stat), linkUpdates });
    }

    if (pathname === '/api/attachments' && req.method === 'POST') {
      const buf = await readBodyBuffer(req, 500 * 1024 * 1024);
      if (!buf.length) return send(res, 400, { error: 'empty body' });
      // Spaces and parens break markdown link destinations — dash them out.
      let name = (url.searchParams.get('name') || '')
        .split(/[/\\]/).pop()
        .replace(/[<>:"|?*]/g, '')
        .trim()
        .replace(/[\s()]+/g, '-')
        .replace(/-+(\.[^.]*)$/, '$1');
      if (!name || name.startsWith('.')) {
        const extMap = {
          'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
          'image/webp': '.webp', 'image/svg+xml': '.svg'
        };
        const ext = extMap[(req.headers['content-type'] || '').split(';')[0]] || '.png';
        const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
        name = `Clipboard_${stamp}${ext}`;
      }
      const dot = name.lastIndexOf('.');
      let final = name;
      let n = 2;
      while (await fileExists(path.join(ATTACH_DIR, final))) {
        final = dot > 0 ? `${name.slice(0, dot)} ${n++}${name.slice(dot)}` : `${name} ${n++}`;
      }
      await fsp.writeFile(path.join(ATTACH_DIR, final), buf);
      // A .blend can't render in the browser — if Blender is installed,
      // convert it headlessly to .glb for the interactive 3D viewer.
      if (final.endsWith('.blend') && BLENDER_BIN) {
        const glbName = final.replace(/\.blend$/, '.glb');
        const glbPath = path.join(ATTACH_DIR, glbName);
        try {
          await new Promise((resolve, reject) => {
            execFile(
              BLENDER_BIN,
              ['-b', path.join(ATTACH_DIR, final), '--python-expr',
               `import bpy; bpy.ops.export_scene.gltf(filepath=r'''${glbPath}''')`],
              { timeout: 180 * 1000, maxBuffer: 16 * 1024 * 1024 },
              (err) => (err ? reject(err) : resolve())
            );
          });
          if (await fileExists(glbPath)) {
            return send(res, 201, { file: final, model: glbName });
          }
        } catch (err) {
          console.error('blend conversion failed:', err.message);
        }
      }
      return send(res, 201, { file: final });
    }

    // Transcribe an attachment by name: ffmpeg streams it to 16kHz mono WAV
    // (constant memory, any length), then whisper.cpp runs locally.
    if (pathname === '/api/transcribe' && req.method === 'POST') {
      if (!WHISPER_BIN) return send(res, 503, { error: 'whisper-cli not installed (brew install whisper-cpp)' });
      if (!FFMPEG_BIN) return send(res, 503, { error: 'ffmpeg not installed (brew install ffmpeg)' });
      if (!(await fileExists(WHISPER_MODEL))) {
        return send(res, 503, { error: 'whisper model missing at models/ggml-small.bin' });
      }
      const { file } = JSON.parse(await readBody(req) || '{}');
      if (!file || file !== path.basename(file) || file.startsWith('.')) {
        return send(res, 400, { error: 'bad filename' });
      }
      const audioPath = path.join(ATTACH_DIR, file);
      if (!(await fileExists(audioPath))) return send(res, 404, { error: 'attachment not found' });
      const tmp = path.join(os.tmpdir(), `notes-transcribe-${Date.now()}.wav`);
      try {
        // Convert and detect silences in one pass — pauses mark speaker turns.
        const ffStderr = await new Promise((resolve, reject) => {
          execFile(
            FFMPEG_BIN,
            ['-y', '-i', audioPath, '-af', 'silencedetect=noise=-30dB:d=0.8', '-ar', '16000', '-ac', '1', '-f', 'wav', tmp],
            { timeout: 30 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 },
            (err, stdout, stderr) => (err ? reject(new Error('audio conversion failed')) : resolve(stderr))
          );
        });
        const silences = [...ffStderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => parseFloat(m[1]));
        const stdout = await new Promise((resolve, reject) => {
          execFile(
            WHISPER_BIN,
            ['-m', WHISPER_MODEL, '-f', tmp, '-l', 'auto', '-np', '-ml', '80', '-sow'],
            { timeout: 120 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 },
            (err, out) => (err ? reject(err) : resolve(out))
          );
        });
        // Prefer Claude speaker attribution; fall back to pause-based turns.
        let text = null;
        const segs = parseSegments(stdout);
        const totalChars = segs.reduce((a, s) => a + s.text.length, 0);
        if (CLAUDE_BIN && segs.length && totalChars < 100000) {
          try {
            text = await attributeSpeakers(segs);
          } catch (err) {
            console.error('speaker attribution fell back:', err.message);
          }
        }
        if (!text) text = formatTranscript(stdout, silences);
        return send(res, 200, { text });
      } catch (err) {
        console.error('transcribe:', err.message);
        return send(res, 500, { error: 'transcription failed: ' + String(err.message).slice(0, 200) });
      } finally {
        fsp.unlink(tmp).catch(() => {});
      }
    }

    // Crash-safe recording: the client streams chunks here while recording.
    if (pathname === '/api/rec-chunk' && (req.method === 'POST' || req.method === 'DELETE')) {
      const name = url.searchParams.get('name') || '';
      if (name !== path.basename(name) || !name.endsWith('.part') || name.startsWith('.')) {
        return send(res, 400, { error: 'bad chunk name' });
      }
      const partPath = path.join(ATTACH_DIR, name);
      if (req.method === 'DELETE') {
        await fsp.unlink(partPath).catch(() => {});
        return send(res, 200, { ok: true });
      }
      const chunk = await readBodyBuffer(req, 64 * 1024 * 1024);
      await fsp.appendFile(partPath, chunk);
      return send(res, 200, { ok: true });
    }

    // Orphaned .part files from a crash, renamed at boot — see startup scan.
    if (pathname === '/api/recovered' && req.method === 'GET') {
      const list = recoveredFiles.splice(0);
      return send(res, 200, list);
    }

    // Summarize a transcript via the local claude CLI (uses the user's own plan).
    if (pathname === '/api/summarize' && req.method === 'POST') {
      if (!CLAUDE_BIN) return send(res, 503, { error: 'claude CLI not found' });
      const { text, title } = JSON.parse(await readBody(req) || '{}');
      if (!text || !text.trim()) return send(res, 400, { error: 'empty transcript' });
      const prompt =
        'Below is an automatic transcript of a meeting' + (title ? ` ("${title}")` : '') + '. ' +
        'Write concise meeting notes in markdown, strictly in the same language the transcript is written in: ' +
        'a few bullet points of key topics, any decisions made, and action items (with owners if mentioned). ' +
        'No preamble, no heading — start directly with the bullets. The transcript may contain recognition errors; ignore obvious noise.';
      try {
        const summary = await new Promise((resolve, reject) => {
          const child = execFile(
            CLAUDE_BIN,
            ['-p', prompt],
            { timeout: 600 * 1000, maxBuffer: 16 * 1024 * 1024, cwd: os.tmpdir() },
            (err, stdout) => (err ? reject(err) : resolve(stdout))
          );
          child.stdin.write(text);
          child.stdin.end();
        });
        return send(res, 200, { summary: summary.trim() });
      } catch (err) {
        console.error('summarize:', err.message);
        return send(res, 500, { error: 'summary failed: ' + String(err.message).slice(0, 200) });
      }
    }

    // Extract suggested todos from a meeting note (or any text) via the claude CLI.
    if (pathname === '/api/todo-suggest' && req.method === 'POST') {
      if (!CLAUDE_BIN) return send(res, 503, { error: 'claude CLI not found' });
      const { text, title } = JSON.parse(await readBody(req) || '{}');
      if (!text || !text.trim()) return send(res, 400, { error: 'empty text' });
      const prompt =
        'Below is a note' + (title ? ` ("${title}")` : '') + ' — it may be meeting notes, a transcript, ' +
        'a plan, or general writing. Extract the concrete action items / next steps as a JSON array of short ' +
        'imperative todo strings, in the same language the source is written in. Only real tasks someone could ' +
        'check off — no topics, no facts, no decisions that need no follow-up. At most 10 items. ' +
        'Output ONLY the JSON array, nothing else. No items → output [].';
      try {
        const out = await new Promise((resolve, reject) => {
          const child = execFile(
            CLAUDE_BIN,
            ['-p', prompt],
            { timeout: 300 * 1000, maxBuffer: 16 * 1024 * 1024, cwd: os.tmpdir() },
            (err, stdout) => (err ? reject(err) : resolve(stdout))
          );
          child.stdin.write(text.slice(0, 200 * 1024));
          child.stdin.end();
        });
        const s = out.indexOf('[');
        const e = out.lastIndexOf(']');
        let suggestions = [];
        if (s !== -1 && e > s) {
          try {
            suggestions = JSON.parse(out.slice(s, e + 1)).filter((x) => typeof x === 'string' && x.trim());
          } catch { /* fall through to empty */ }
        }
        return send(res, 200, { suggestions: suggestions.slice(0, 10) });
      } catch (err) {
        console.error('todo-suggest:', err.message);
        return send(res, 500, { error: 'suggest failed: ' + String(err.message).slice(0, 200) });
      }
    }

    if (pathname === '/api/trash' && req.method === 'GET') {
      await fsp.mkdir(TRASH_DIR, { recursive: true });
      const items = (await fsp.readdir(TRASH_DIR))
        .filter((f) => f.endsWith('.md'))
        .map((f) => {
          const sp = f.indexOf(' ');
          const stamp = sp > 0 ? f.slice(0, sp) : '';
          const m = stamp.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/);
          return {
            file: f,
            original: sp > 0 ? f.slice(sp + 1) : f,
            deleted: m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : null
          };
        })
        .sort((a, b) => (b.deleted || '').localeCompare(a.deleted || ''));
      return send(res, 200, items);
    }

    if ((pathname === '/api/trash/restore' || pathname === '/api/trash/delete') && req.method === 'POST') {
      const { file } = JSON.parse(await readBody(req) || '{}');
      if (!file || file !== path.basename(file) || !file.endsWith('.md')) {
        return send(res, 400, { error: 'bad filename' });
      }
      const trashPath = path.join(TRASH_DIR, file);
      if (pathname === '/api/trash/delete') {
        await fsp.unlink(trashPath);
        return send(res, 200, { ok: true });
      }
      const sp = file.indexOf(' ');
      const original = sp > 0 ? file.slice(sp + 1) : file;
      let target = original;
      let n = 2;
      while (await fileExists(path.join(NOTES_DIR, target))) {
        target = `${original.replace(/\.md$/, '')} ${n++}.md`;
      }
      await fsp.rename(trashPath, path.join(NOTES_DIR, target));
      return send(res, 200, { file: target });
    }

    const noteMatch = pathname.match(/^\/api\/notes\/(.+)$/);
    if (noteMatch) {
      let file = safeName(noteMatch[1]);
      if (!file || !file.endsWith('.md')) return send(res, 400, { error: 'bad filename' });
      // macOS stores filenames NFD-decomposed; accept either Unicode form.
      const exists = (f) => fsp.access(path.join(NOTES_DIR, f)).then(() => true, () => false);
      if (!(await exists(file)) && (await exists(file.normalize('NFD')))) {
        file = file.normalize('NFD');
      }
      const full = path.join(NOTES_DIR, file);

      if (req.method === 'GET') {
        const raw = await fsp.readFile(full, 'utf8');
        return send(res, 200, raw, 'text/markdown; charset=utf-8');
      }
      if (req.method === 'PUT') {
        const raw = touchModified(await readBody(req), new Date().toISOString());
        await fsp.writeFile(full, raw, 'utf8');
        const stat = await fsp.stat(full);
        return send(res, 200, noteFromRaw(file, raw, stat));
      }
      if (req.method === 'DELETE') {
        await fsp.mkdir(TRASH_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        await fsp.rename(full, path.join(TRASH_DIR, `${stamp} ${file}`));
        return send(res, 200, { ok: true });
      }
      return send(res, 405, { error: 'method not allowed' });
    }

    if (pathname.startsWith('/attachments/')) {
      return serveStatic(res, ATTACH_DIR, pathname.slice('/attachments/'.length), req.headers.range);
    }

    return serveStatic(res, PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname.slice(1), req.headers.range);
  } catch (err) {
    if (err.code === 'ENOENT') return send(res, 404, { error: 'not found' });
    console.error(err);
    return send(res, 500, { error: 'server error' });
  }
});

// Transcribing hours of audio takes many minutes — never kill the request.
server.requestTimeout = 0;
server.headersTimeout = 60 * 1000;

// First run on a fresh clone: the data dirs don't exist yet.
fs.mkdirSync(NOTES_DIR, { recursive: true });
fs.mkdirSync(ATTACH_DIR, { recursive: true });

// Agent docs travel with the data: seed AGENTS.md/CLAUDE.md into the data
// dir (bundled installs) so agents pointed at ~/Documents/Marknote know the
// file formats and API. Refreshed on app updates unless the user edited them.
(async () => {
  try {
    if (DATA_ROOT === ROOT) return;
    await fsp.mkdir(DATA_ROOT, { recursive: true });
    for (const f of ['AGENTS.md', 'CLAUDE.md']) {
      const src = path.join(ROOT, f);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(DATA_ROOT, f);
      let write = !(await fileExists(dst));
      if (!write) {
        const cur = await fsp.readFile(dst, 'utf8');
        write = cur.startsWith('# Marknote'); // still ours → keep it current
      }
      if (write) await fsp.copyFile(src, dst);
    }
  } catch (err) { console.error('agent docs seed:', err.message); }
})();

// Fresh install (bundled app): greet the user so the empty state isn't scary.
(async () => {
  try {
    if (!BUNDLED && !process.env.MARKNOTE_DATA) return;
    await fsp.mkdir(NOTES_DIR, { recursive: true });
    const existing = (await fsp.readdir(NOTES_DIR)).filter((f) => f.endsWith('.md'));
    if (existing.length) return;
    const iso = new Date().toISOString();
    await fsp.writeFile(path.join(NOTES_DIR, 'Welcome to Marknote.md'), `---
tags: [Guide]
title: 'Welcome to Marknote'
created: '${iso}'
modified: '${iso}'
pinned: true
---

# Welcome to Marknote 👋

Your notes live as plain markdown files in **~/Documents/Marknote/** — no
database, no cloud. Take them anywhere.

## The basics

- **+ Create** — notes, presentations, meeting recordings, or from a template
- **⌘P** jump to a note · **/** search · **⌘E** edit
- Link notes by typing "[[" — backlinks appear automatically
- Drag in images, video, audio, even 3D models (.glb)
- Tables: press Tab inside one — it formats itself
- Lock sensitive notes with the 🔒 button (AES-encrypted on disk)
- **Backup** (bottom left) exports everything as a zip

## Presentations

Split a note into slides with "---" lines and press **Present**. With a second
screen connected you get presenter mode: slides on the big screen, speaker
notes on yours.

## Optional extras (AI features)

- **Meeting transcription**: install whisper-cpp and ffmpeg (brew install
  whisper-cpp ffmpeg) and put ggml-small.bin in ~/Documents/Marknote/models/
- **Summaries & todo suggestions**: install the Claude Code CLI
  (https://claude.com/claude-code) and sign in once

Everything else works without them. Delete this note whenever you like!
`);
    console.log('seeded welcome note');
  } catch (err) { console.error('welcome seed:', err.message); }
})();

// First run: seed a few starter templates (skipped once any template exists).
(async () => {
  try {
    await fsp.mkdir(TEMPLATES_DIR, { recursive: true });
    const existing = (await fsp.readdir(TEMPLATES_DIR)).filter((f) => f.endsWith('.md'));
    if (existing.length) return;
    const seed = (file, txt) => fsp.writeFile(path.join(TEMPLATES_DIR, file), txt);
    await seed('research.md', `---
tags: [Research]
title: 'Research'
---

# {{title}}

*Skapad {{date}}*

## Sammanfattning

## Källor

- [Länk](https://)

## Ordlista — förkortningar

| Förkortning | Står för | Kort förklaring |
| ----------- | -------- | --------------- |
|             |          |                 |
`);
    await seed('pitchdeck.md', `---
tags: [Presentation]
title: 'Pitchdeck'
---

<!-- transition: slide -->

# {{title}}

Undertitel

<!-- notes
Talarnoter för titelsliden.
-->

---

## Problemet

<!-- steps -->

- Punkt som klickas fram
- Nästa punkt

---

## Så hänger det ihop

\`\`\`mermaid
flowchart LR
  A[Start] --> B[Steg]
  B --> C[Resultat]
\`\`\`

---

## Lösningen

---

# Nästa steg
`);
    await seed('motesanteckning.md', `---
tags: [Meeting]
title: 'Mötesanteckning'
---

# {{title}}

*{{date}}*

## Närvarande

-

## Agenda

-

## Beslut

-

## Att göra

- [ ]
`);
    console.log('seeded starter templates');
  } catch (err) { console.error('template seed:', err.message); }
})();

// Rescue recordings whose app died mid-meeting: orphaned .part files become
// playable .weba files, and the client turns them into notes on next load.
const recoveredFiles = [];
(async () => {
  try {
    for (const f of await fsp.readdir(ATTACH_DIR)) {
      if (!f.endsWith('.part')) continue;
      const rescued = f.replace(/\.weba\.part$/, '').replace(/\.part$/, '') + '-recovered.weba';
      await fsp.rename(path.join(ATTACH_DIR, f), path.join(ATTACH_DIR, rescued));
      recoveredFiles.push(rescued);
      console.log('recovered recording:', rescued);
    }
  } catch { /* attachments dir missing on first run */ }
})();

// ——— todo reminders ———
// Todos live in notes/Todos.md as task-list lines:  - [ ] Text @2026-08-27 !09:30
// A line with both a date and a !time gets a macOS notification at that moment
// (while the app is running). Fired reminders are recorded in .todo-reminders.json
// so they never fire twice; reminders more than 2h stale are swallowed silently.
const REMIND_STATE = path.join(DATA_ROOT, '.todo-reminders.json');
let remindState = {};
try { remindState = JSON.parse(fs.readFileSync(REMIND_STATE, 'utf8')); } catch { /* first run */ }

// Script-delivered notification-center banners are easily silenced by per-app
// Notification settings (no banner, no sound — they pile up unseen). A dialog
// window + a directly-played chime depend on no settings at all. The dialog's
// "Klart ✓" button marks the todo done right from the reminder.
function notify(text, line) {
  if (process.platform !== 'darwin') return;
  const safe = String(text).replace(/[\\"]/g, '').slice(0, 200);
  execFile('/usr/bin/afplay', ['/System/Library/Sounds/Glass.aiff'], () => {});
  execFile('/usr/bin/osascript', ['-e',
    `display dialog "${safe}" with title "Marknote — todo reminder" buttons {"Klart ✓", "OK"} default button "OK" with icon note giving up after 600`
  ], async (err, stdout) => {
    if (err || !line || !/button returned:Klart/.test(stdout || '')) return;
    try {
      const p = path.join(NOTES_DIR, 'Todos.md');
      const raw = await fsp.readFile(p, 'utf8');
      if (!raw.includes(line)) return; // todo edited meanwhile — leave it alone
      const done = raw.replace(line, line.replace('- [ ]', '- [x]'));
      await fsp.writeFile(p, touchModified(done, new Date().toISOString()));
    } catch { /* best-effort */ }
  });
}

async function scanReminders() {
  let raw;
  try { raw = await fsp.readFile(path.join(NOTES_DIR, 'Todos.md'), 'utf8'); } catch { return; }
  const now = new Date();
  let changed = false;
  for (const line of raw.split('\n')) {
    const m = line.match(/^- \[ \] (.*)$/);
    if (!m) continue;
    const dm = m[1].match(/@(\d{4}-\d{2}-\d{2})/);
    const tm = m[1].match(/!(\d{1,2}):(\d{2})/);
    if (!dm || !tm) continue;
    // no timezone suffix → parsed as local time, which is what the user meant
    const when = new Date(`${dm[1]}T${tm[1].padStart(2, '0')}:${tm[2]}:00`);
    if (isNaN(when) || when > now) continue;
    const text = m[1]
      .replace(/@\d{4}-\d{2}-\d{2}/, '').replace(/!\d{1,2}:\d{2}/, '')
      .replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/\s+/g, ' ').trim();
    const key = `${dm[1]} ${tm[0]} ${text}`;
    if (remindState[key]) continue;
    remindState[key] = now.toISOString();
    changed = true;
    if (now - when < 2 * 3600 * 1000) notify('Remember: ' + text, line);
  }
  if (changed) fsp.writeFile(REMIND_STATE, JSON.stringify(remindState, null, 1)).catch(() => {});
}

function start() {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => {
      console.log(`Notes running at http://localhost:${PORT}`);
      setInterval(scanReminders, 30 * 1000);
      scanReminders();
      resolve(PORT);
    });
  });
}

module.exports = { start, PORT, DATA_ROOT };

if (require.main === module) {
  start().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
