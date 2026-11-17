/*
  ساخت library.auto.json + پیدا کردن کاور آهنگ و عکس خواننده

  هر آهنگی که توی این پوشه‌ها بذاری خودکار به لایبریری اضافه می‌شه:
    assets/music/<Artist>/singles/*.mp3
    assets/music/<Artist>/albums/<AlbumName>/*.mp3
  (mp3 که مستقیم داخل albums باشه هم یه آلبوم هم‌اسم خواننده می‌سازه)

  ترتیب آهنگ‌های آلبوم فقط از روی شماره ابتدای اسم فایل تعیین می‌شه. فایل‌های بدون شماره می‌رن آخر.

  ─── کاور و عکس: به این ترتیب ───
    ۱. عکسی که خودت گذاشتی (همیشه اولویت داره و هیچ‌وقت عوض یا پاک نمی‌شه)
         تک‌آهنگ:   <نام‌آهنگ>.jpg|png|webp   کنار mp3
         آلبوم:      cover.* / folder.* / front.* / album.* ، عکس هم‌اسم آلبوم، یا اولین عکس پوشه
         خواننده:   photo.* ، عکس هم‌اسم خواننده، یا هر عکس داخل پوشه خواننده
    ۲. کاوری که خود فایل mp3 داخلش داره (ID3) ← بیرون کشیده و کنار فایل ذخیره می‌شه
    ۳. Spotify (فقط تک‌آهنگ‌ها و عکس خواننده‌ها، و فقط وقتی اسم دقیقاً بخونه)
    اگه هیچ‌کدوم پیدا نشد، چیزی ذخیره نمی‌شه و خودت بعداً آپلود می‌کنی.

  فایل‌هایی که اسکریپت خودش می‌سازه اسمشون «.auto.» داره، مثلاً  photo.auto.jpg  یا  Song.auto.jpg
  و هر عکسی که خودت بذاری همیشه جلوتر از اونا انتخاب می‌شه. هر وقت خواستی عوضش کنی
  فقط فایل .auto رو پاک کن یا عکس خودت رو کنارش بذار.

  Spotify فقط وقتی فعاله که کلید بدی (developer.spotify.com/dashboard):
    SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET

  متغیرهای محیطی:
    NO_COVERS=1       اصلاً دنبال عکس نگرده
    FORCE_COVERS=1    کش «پیدا نشد» رو نادیده بگیره

  اگه اسم پوشه خواننده فارسیه و توی اسپاتیفای انگلیسی ثبت شده، داخل پوشه‌اش فایل info.json بساز:
    { "searchName": "Hichkas" }
*/
const fs = require('fs');
const path = require('path');

const env = process.env;
const assetsDir = path.join(__dirname, '..', 'assets');
const musicDir = path.join(assetsDir, 'music');
const libFile = path.join(assetsDir, 'library.json');
const cacheFile = path.join(assetsDir, '.cover-cache.json');

const IMG_EXT = ['jpg', 'jpeg', 'png', 'webp'];
const EXT_GROUP = IMG_EXT.join('|');
const IMG_RE = new RegExp(`\\.(${EXT_GROUP})$`, 'i');
const AUTO_RE = /\.auto\.[a-z0-9]+$/i;         // فایل‌هایی که خود اسکریپت ساخته
const RETRY_MS = 30 * 24 * 3600 * 1000;        // «پیدا نشد» رو ۳۰ روز بعد دوباره امتحان می‌کنه
const sleep = ms => new Promise(r => setTimeout(r, ms));
const enc = encodeURIComponent;
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ---------- مقایسه اسم‌ها ---------- */
const norm = s => String(s || '').normalize('NFKD')
  .replace(/[\u0300-\u036f\u064b-\u065f\u200c]/g, '')
  .toLowerCase()
  .replace(/[\u064a\u0649]/g, '\u06cc').replace(/\u0643/g, '\u06a9')
  .replace(/\(.*?\)|\[.*?\]/g, ' ')
  .replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ').trim();

// اسم آهنگ: برابر، یا یکی داخل اون یکی (فقط اگه کلمه به اندازه کافی بلند باشه)
const titleMatch = (a, b) => {
  a = norm(a); b = norm(b);
  if (!a || !b) return false;
  if (a === b) return true;
  return Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a));
};
const similar = (a, b) => {
  a = norm(a); b = norm(b);
  return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
};

const SEP = /\s[-\u2013\u2014]\s/;
const titleOf = base => SEP.test(base) ? base.split(SEP).slice(1).join(' - ') : base;
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

// ارقام فارسی/عربی رو به انگلیسی تبدیل می‌کنه
const faDigits = s => s
  .replace(/[\u06f0-\u06f9]/g, c => c.charCodeAt(0) - 0x06f0)
  .replace(/[\u0660-\u0669]/g, c => c.charCodeAt(0) - 0x0660);

// شماره ترک رو از اسم فایل درمیاره:
// "01 - Name", "01. Name", "1) Name", "01 Name", "01_Name", "Track 03", "Artist - 05 - Name", "۰۳ اسم"
// (چیزی مثل "2Pac - ..." شماره حساب نمی‌شه چون بعد از عدد باید جداکننده باشه)
function parseTrack(base, artistName) {
  const s = faDigits(base).trim();
  const re = /^(?:track\s*)?(\d{1,3})(?!\d)(?:[\s\-._)\]:]+|$)(.*)$/i;
  let m = s.match(re);
  if (!m && SEP.test(s)) {                        // حالت "Artist - 05 - Name"
    m = s.split(SEP).slice(1).join(' - ').trim().match(re);
  }
  if (!m) return { num: null, title: titleOf(base).trim() || base };
  let title = m[2].trim();
  // "01 Hiphopologist - Sogand" -> "Sogand"
  if (SEP.test(title)) {
    const parts = title.split(SEP);
    if (similar(parts[0], artistName)) title = parts.slice(1).join(' - ').trim();
  }
  return { num: parseInt(m[1], 10), title: title || ('Track ' + m[1]) };
}

/* ---------- عکس‌ها: کدوم فایل مال خودته و کدوم مال اسکریپت ---------- */
const isImg = f => IMG_RE.test(f);
const isAuto = f => AUTO_RE.test(f);

// عکس هم‌اسم یک آهنگ: اول عکس خودت، بعد .auto
function findImgFor(files, base) {
  const own = new RegExp(`^${escapeRe(base)}\\.(${EXT_GROUP})$`, 'i');
  const auto = new RegExp(`^${escapeRe(base)}\\.auto\\.(${EXT_GROUP})$`, 'i');
  return files.find(f => own.test(f)) || files.find(f => auto.test(f)) || null;
}

// عکس خواننده: photo.* ، عکسی به اسم خواننده، هر عکس دیگه‌ای که خودت گذاشتی؛ اگه نبود photo.auto.*
function findLocalPhoto(artistPath, artistName) {
  const imgs = fs.readdirSync(artistPath, { withFileTypes: true })
    .filter(d => d.isFile() && isImg(d.name)).map(d => d.name).sort();
  const mine = imgs.filter(f => !isAuto(f));
  return mine.find(f => /^photo\./i.test(f))
      || mine.find(f => norm(path.parse(f).name) === norm(artistName))
      || mine[0]
      || imgs.find(f => /^photo\.auto\./i.test(f))
      || null;
}

/* ---------- خواندن کاور داخل خود mp3 (ID3v2.2 / 2.3 / 2.4، بدون نیاز به پکیج) ---------- */
const syncsafe = (b, o) => ((b[o] & 127) << 21) | ((b[o + 1] & 127) << 14) | ((b[o + 2] & 127) << 7) | (b[o + 3] & 127);

function sniffExt(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function parsePicture(d, ver) {
  let i = 0;
  const textEnc = d[i++];
  if (ver === 2) i += 3;                               // فرمت ۳ حرفی (JPG/PNG)
  else { const e = d.indexOf(0, i); if (e < 0) return null; i = e + 1; }   // mime
  const type = d[i++];
  if (textEnc === 1 || textEnc === 2) {                // توضیح UTF-16
    while (i + 1 < d.length && !(d[i] === 0 && d[i + 1] === 0)) i += 2;
    i += 2;
  } else { const e = d.indexOf(0, i); if (e < 0) return null; i = e + 1; }
  const img = d.slice(i), ext = sniffExt(img);
  return ext ? { type, img, ext } : null;
}

function embeddedCover(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const h = Buffer.alloc(10);
    if (fs.readSync(fd, h, 0, 10, 0) < 10 || h.toString('latin1', 0, 3) !== 'ID3') return null;
    const ver = h[3], flags = h[5], size = syncsafe(h, 6);
    if (ver < 2 || ver > 4 || !size) return null;
    const len = Math.min(size, 32 * 1024 * 1024);
    let buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 10);
    if (flags & 0x80) {                                // unsynchronisation
      const out = [];
      for (let i = 0; i < buf.length; i++) { out.push(buf[i]); if (buf[i] === 0xff && buf[i + 1] === 0) i++; }
      buf = Buffer.from(out);
    }
    let pos = 0;
    if ((flags & 0x40) && ver >= 3) pos = ver === 4 ? syncsafe(buf, 0) : buf.readUInt32BE(0) + 4;
    const hl = ver === 2 ? 6 : 10, found = [];
    while (pos + hl <= buf.length && buf[pos] !== 0) {
      const id = buf.toString('latin1', pos, pos + (ver === 2 ? 3 : 4));
      const fsz = ver === 2 ? (buf[pos + 3] << 16) | (buf[pos + 4] << 8) | buf[pos + 5]
                : ver === 4 ? syncsafe(buf, pos + 4) : buf.readUInt32BE(pos + 4);
      if (fsz <= 0 || pos + hl + fsz > buf.length) break;
      if (id === 'APIC' || id === 'PIC') {
        let d = buf.slice(pos + hl, pos + hl + fsz), skip = false, off = 0;
        const fl = ver >= 3 ? buf[pos + 9] : 0;
        if (ver === 4) { if (fl & 0x0c) skip = true; if (fl & 0x40) off += 1; if (fl & 0x01) off += 4; }
        if (ver === 3) { if (fl & 0xc0) skip = true; if (fl & 0x20) off += 1; }
        if (!skip) {
          const p = parsePicture(d.slice(off), ver);
          if (p) found.push(p);
        }
      }
      pos += hl + fsz;
    }
    return found.find(p => p.type === 3) || found[0] || null;     // type 3 = کاور جلو
  } catch { return null; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

// کاور داخل mp3 رو کنار فایل ذخیره می‌کنه (destBase بدون پسوند). چیزی رو overwrite نمی‌کنه.
function saveEmbedded(mp3Path, destBase) {
  const c = embeddedCover(mp3Path);
  if (!c) return null;
  const dest = `${destBase}.auto.${c.ext}`;
  if (fs.existsSync(dest)) return dest;
  fs.writeFileSync(dest, c.img);
  return dest;
}

/* ---------- شبکه ---------- */
async function getJson(url, opts = {}, tries = 3) {
  try {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
    if (r.status === 429 && tries > 1) {              // Spotify گفته آروم‌تر
      const w = Math.min(+r.headers.get('retry-after') || 5, 60);
      console.log(`  rate limited, waiting ${w}s...`);
      await sleep(w * 1000);
      return getJson(url, opts, tries - 1);
    }
    return r.ok ? { data: await r.json() } : { error: 'HTTP ' + r.status };
  } catch (e) { return { error: e.message }; }
}

// عکس رو دانلود می‌کنه و به شکل <destBase>.auto.<ext> ذخیره می‌کنه (هیچ فایل موجودی رو عوض نمی‌کنه)
async function download(url, destBase) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) { console.log('  download failed: HTTP ' + r.status); return null; }
    const buf = Buffer.from(await r.arrayBuffer());
    const ext = sniffExt(buf);
    if (!ext) { console.log('  download failed: not an image'); return null; }
    const dest = `${destBase}.auto.${ext}`;
    if (fs.existsSync(dest)) return dest;
    fs.writeFileSync(dest, buf);
    return dest;
  } catch (e) { console.log('  download failed: ' + e.message); return null; }
}

/* ---------- Spotify (تنها منبع) ---------- */
const hasSpotify = () => !!(env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET);
let spToken = null, spTokenAt = 0, spFailed = false;
async function spotifyToken() {
  if (spFailed) return null;
  if (spToken && Date.now() - spTokenAt < 50 * 60 * 1000) return spToken;
  const r = await getJson('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(env.SPOTIFY_CLIENT_ID + ':' + env.SPOTIFY_CLIENT_SECRET).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (r.error || !r.data || !r.data.access_token) {
    console.log('!! Spotify login failed: ' + (r.error || 'no token') + ' - check SPOTIFY_CLIENT_ID / SECRET');
    spFailed = true;
    return null;
  }
  spTokenAt = Date.now();
  return (spToken = r.data.access_token);
}

const spSearch = async (type, q, limit) => {
  const tok = await spotifyToken();
  if (!tok) return { error: 'no token' };
  await sleep(300);
  return getJson(`https://api.spotify.com/v1/search?type=${type}&limit=${limit}&q=${enc(q)}`,
    { headers: { Authorization: 'Bearer ' + tok } });
};

// کاور آهنگ: اسم خواننده باید دقیقاً یکی از خواننده‌های آهنگ باشه و اسم آهنگ هم بخونه
async function findCover(artist, title) {
  const r = await spSearch('track', `track:"${title}" artist:"${artist}"`, 10);
  if (r.error) { console.log('  Spotify: ERROR ' + r.error); return { url: null, failed: true }; }
  const items = (r.data && r.data.tracks && r.data.tracks.items) || [];
  console.log(`  Spotify: ${items.length} results` + (items[0] ? ` (first: "${(items[0].artists || []).map(a => a.name).join(', ')} - ${items[0].name}")` : ''));
  const hit = items.find(x =>
    x.album && x.album.images && x.album.images[0] &&
    (x.artists || []).some(a => norm(a.name) === norm(artist)) &&
    titleMatch(x.name, title));
  return { url: hit ? hit.album.images[0].url : null, failed: false };
}

// عکس خواننده: فقط وقتی اسم دقیقاً یکی باشه
async function findArtistPhoto(name) {
  const r = await spSearch('artist', `artist:"${name}"`, 5);
  if (r.error) { console.log('  Spotify: ERROR ' + r.error); return { url: null, failed: true }; }
  const items = (r.data && r.data.artists && r.data.artists.items) || [];
  console.log(`  Spotify: ${items.length} results` + (items[0] ? ` (first: "${items[0].name}")` : ''));
  const hit = items.find(x => x.images && x.images[0] && norm(x.name) === norm(name));
  return { url: hit ? hit.images[0].url : null, failed: false };
}

/* ---------- پوشه‌ها و فایل‌ها ---------- */
function searchNameOf(artistPath, artistName) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(artistPath, 'info.json'), 'utf8'));
    if (j.searchName) return j.searchName;
  } catch {}
  return artistName;
}

const artistDirs = () => fs.existsSync(musicDir)
  ? fs.readdirSync(musicDir, { withFileTypes: true }).filter(d => d.isDirectory()) : [];

const filesIn = dir => fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isFile()).map(d => d.name);

/* ---------- خواندن آلبوم‌ها ---------- */
// dir: پوشه فایل‌ها ، rel: مسیر نسبی برای سایت ، loose: آهنگ‌هایی که مستقیم داخل albums هستن
function buildAlbum(title, dir, rel, artistName, loose) {
  const files = filesIn(dir);
  const mp3s = files.filter(f => f.toLowerCase().endsWith('.mp3'));
  if (!mp3s.length) return null;
  const imgs = files.filter(isImg).sort(natural);

  // اول عکس‌های خودت، بعد .auto
  const pick = list => list.find(f => /^(cover|folder|front|album)\./i.test(f))
    || (loose ? null : (list.find(f => norm(path.parse(f).name.replace(/\.auto$/i, '')) === norm(title)) || list[0] || null));
  const albumCover = pick(imgs.filter(f => !isAuto(f))) || pick(imgs.filter(isAuto));
  const coverPath = albumCover ? `${rel}/${albumCover}` : null;

  // ترتیب: فقط بر اساس شماره. فایل‌های بدون شماره می‌رن آخر (به ترتیب الفبایی)
  const parsed = mp3s.map(file => ({ file, ...parseTrack(path.parse(file).name, artistName) }))
    .sort((a, b) => {
      if (a.num !== null && b.num !== null && a.num !== b.num) return a.num - b.num;
      if (a.num !== null && b.num === null) return -1;
      if (a.num === null && b.num !== null) return 1;
      return natural(a.file, b.file);
    });

  const tracks = parsed.map(p => {
    const own = findImgFor(imgs, path.parse(p.file).name);
    return {
      title: p.title,
      artist: artistName,
      audio: `${rel}/${p.file}`,
      cover: own ? `${rel}/${own}` : coverPath
    };
  });
  return { title, artist: artistName, cover: coverPath, tracks };
}

function readAlbums(artistPath, artistName) {
  const albumsPath = path.join(artistPath, 'albums');
  if (!fs.existsSync(albumsPath)) return [];
  const base = `music/${artistName}/albums`;
  const out = [];

  const loose = buildAlbum(artistName, albumsPath, base, artistName, true);
  if (loose) out.push(loose);

  fs.readdirSync(albumsPath, { withFileTypes: true })
    .filter(d => d.isDirectory()).map(d => d.name).sort(natural)
    .forEach(name => {
      const alb = buildAlbum(name, path.join(albumsPath, name), `${base}/${name}`, artistName, false);
      if (alb) out.push(alb);
    });
  return out;
}

/* ---------- اصلی ---------- */
async function main() {
  // ۱. ساخت پوشه‌ها
  if (!fs.existsSync(musicDir)) fs.mkdirSync(musicDir, { recursive: true });

  if (fs.existsSync(libFile)) {
    try {
      const lib = JSON.parse(fs.readFileSync(libFile, 'utf8'));
      (lib.artists || []).forEach(a => {
        if (!a.name) return;
        const s = path.join(musicDir, a.name, 'singles');
        const alb = path.join(musicDir, a.name, 'albums');
        if (!fs.existsSync(s)) fs.mkdirSync(s, { recursive: true });
        if (!fs.existsSync(alb)) fs.mkdirSync(alb, { recursive: true });
        if (!fs.existsSync(path.join(s, '.gitkeep'))) fs.writeFileSync(path.join(s, '.gitkeep'), '');
        if (!fs.existsSync(path.join(alb, '.gitkeep'))) fs.writeFileSync(path.join(alb, '.gitkeep'), '');
      });
      console.log('Folders created successfully.');
    } catch (e) { console.log('Error reading library.json: ' + e.message); }
  }

  // ۲. کاور و عکس: اول کاور داخل mp3، بعد Spotify
  if (env.NO_COVERS !== '1') {
    let cache = {};
    try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
    if (env.FORCE_COVERS === '1') cache = {};
    const fresh = key => cache[key] && Date.now() - cache[key] < RETRY_MS;
    const stat = { embedded: 0, photos: 0, covers: 0, missed: 0 };

    const spotifyOn = hasSpotify() && typeof fetch === 'function';
    if (hasSpotify() && typeof fetch !== 'function') console.log(`!! Node ${process.version} has no fetch - Node 18+ is required for Spotify.`);
    console.log(spotifyOn ? 'Source: Spotify (+ covers embedded in mp3 files)'
      : 'Spotify is off - set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to enable it (embedded mp3 covers still work).');

    // ۲-الف) کاور داخل mp3: آلبوم‌هایی که هیچ عکسی ندارن
    for (const dir of artistDirs()) {
      const albumsPath = path.join(musicDir, dir.name, 'albums');
      if (!fs.existsSync(albumsPath)) continue;
      const dirs = [albumsPath, ...fs.readdirSync(albumsPath, { withFileTypes: true })
        .filter(d => d.isDirectory()).map(d => path.join(albumsPath, d.name))];
      for (const d of dirs) {
        const files = filesIn(d);
        if (files.some(isImg)) continue;                          // هر عکسی هست دست نمی‌زنیم
        for (const mp3 of files.filter(f => f.toLowerCase().endsWith('.mp3')).sort(natural)) {
          if (saveEmbedded(path.join(d, mp3), path.join(d, 'cover'))) {
            console.log(`Album cover taken from mp3: ${path.relative(musicDir, d)}`);
            stat.embedded++;
            break;
          }
        }
      }
    }

    // ۲-ب) عکس خواننده (فقط Spotify)
    if (spotifyOn) {
      for (const dir of artistDirs()) {
        const artist = dir.name, artistPath = path.join(musicDir, artist);
        if (findLocalPhoto(artistPath, artist)) continue;
        const key = 'photo:' + artist;
        if (fresh(key)) continue;
        const q = searchNameOf(artistPath, artist);
        console.log(`Looking for artist photo: ${q}`);
        const res = await findArtistPhoto(q);
        if (res.url && await download(res.url, path.join(artistPath, 'photo'))) {
          console.log('  -> saved photo.auto.*');
          stat.photos++; delete cache[key];
        } else {
          stat.missed++;
          if (res.url || res.failed) console.log('  -> connection/API problem, will retry next run');
          else { console.log('  -> no exact match (will not retry for 30 days, upload it yourself)'); cache[key] = Date.now(); }
        }
      }
    }

    // ۲-پ) کاور تک‌آهنگ‌ها: کاور داخل mp3 ← Spotify
    for (const dir of artistDirs()) {
      const artist = dir.name, artistPath = path.join(musicDir, artist);
      const singlesPath = path.join(artistPath, 'singles');
      if (!fs.existsSync(singlesPath)) continue;
      const q = searchNameOf(artistPath, artist);

      for (const file of fs.readdirSync(singlesPath).filter(f => f.toLowerCase().endsWith('.mp3'))) {
        const base = path.parse(file).name;
        if (findImgFor(fs.readdirSync(singlesPath), base)) continue;        // عکس داره، دست نمی‌زنیم

        if (saveEmbedded(path.join(singlesPath, file), path.join(singlesPath, base))) {
          console.log(`Cover taken from mp3: ${artist} - ${titleOf(base)}`);
          stat.embedded++;
          continue;
        }
        if (!spotifyOn) continue;

        const key = `${artist}/${base}`;
        if (fresh(key)) continue;
        console.log(`Looking for cover: ${artist} - ${titleOf(base)}`);
        const res = await findCover(q, titleOf(base));
        if (res.url && await download(res.url, path.join(singlesPath, base))) {
          console.log('  -> saved cover (from Spotify)');
          stat.covers++; delete cache[key];
        } else {
          stat.missed++;
          if (res.url || res.failed) console.log('  -> connection/API problem, will retry next run');
          else { console.log('  -> no matching result (will not retry for 30 days, upload it yourself)'); cache[key] = Date.now(); }
        }
      }
    }

    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
    console.log(`Done: ${stat.embedded} covers from mp3 files, ${stat.photos} artist photos and ${stat.covers} covers from Spotify, ${stat.missed} not found.`);
  }

  // ۳. خواندن آهنگ‌ها از پوشه‌ها و ترکیب با library.json
  let manualArtists = [];
  try {
    manualArtists = (JSON.parse(fs.readFileSync(libFile, 'utf8')).artists || []).filter(a => a && a.name);
  } catch {}

  // ۳-الف) اسکن پوشه‌ها
  const scanned = {};
  artistDirs().forEach(dir => {
    const artistName = dir.name;
    const artistPath = path.join(musicDir, artistName);
    const singlesPath = path.join(artistPath, 'singles');
    const obj = { name: artistName, photo: null, description: 'ARTIST', singles: [], albums: [] };

    const photo = findLocalPhoto(artistPath, artistName);
    if (photo) obj.photo = `music/${artistName}/${photo}`;

    if (fs.existsSync(singlesPath)) {
      const all = fs.readdirSync(singlesPath);
      all.filter(f => f.toLowerCase().endsWith('.mp3')).sort(natural).forEach(file => {
        const base = path.parse(file).name;
        const coverFile = findImgFor(all, base);
        obj.singles.push({
          title: titleOf(base),
          artist: artistName,
          audio: `music/${artistName}/singles/${file}`,
          cover: coverFile ? `music/${artistName}/singles/${coverFile}` : null
        });
      });
    }
    obj.albums = readAlbums(artistPath, artistName);
    scanned[norm(artistName)] = obj;
  });

  // ۳-ب) ترکیب با library.json
  const audioKey = p => norm(path.parse(String(p || '')).name);
  const fixSingle = (s, artistName) => {
    if (typeof s === 'string') {
      return { title: titleOf(path.parse(s).name), artist: artistName, audio: s, cover: null };
    }
    return s && s.audio ? s : null;
  };

  const result = { artists: [] };
  const used = new Set();

  manualArtists.forEach(man => {
    const key = norm(man.name);
    used.add(key);
    const sc = scanned[key] || { singles: [], albums: [], photo: null };

    // آهنگ تکراری (هم دستی، هم تو پوشه) فقط یک بار میاد
    const have = new Set(sc.singles.map(s => audioKey(s.audio)));
    const singles = (Array.isArray(man.singles) ? man.singles : [])
      .map(s => fixSingle(s, man.name))
      .filter(s => s && !have.has(audioKey(s.audio)))
      .concat(sc.singles);

    // آلبوم‌های دستی (فقط آبجکت‌های درست) + آلبوم‌های پوشه با اسم متفاوت
    const manAlbums = (Array.isArray(man.albums) ? man.albums : [])
      .filter(a => a && typeof a === 'object' && Array.isArray(a.tracks));
    const manTitles = new Set(manAlbums.map(a => norm(a.title)));
    const albums = manAlbums.concat(sc.albums.filter(a => !manTitles.has(norm(a.title))));

    const { singles: _s, albums: _a, ...rest } = man;      // aliases و بقیه فیلدها حفظ می‌شن
    result.artists.push({
      ...rest,
      name: man.name,
      photo: man.photo || sc.photo || null,                // عکسی که تو library.json گذاشتی اولویت داره
      description: man.description || 'ARTIST',
      singles,
      albums
    });
  });

  // خواننده‌هایی که فقط تو پوشه هستن
  Object.keys(scanned).filter(k => !used.has(k)).forEach(k => {
    const a = scanned[k];
    if (a.singles.length || a.albums.length) result.artists.push(a);
  });

  fs.writeFileSync(path.join(assetsDir, 'library.auto.json'), JSON.stringify(result, null, 2));
  const nAlb = result.artists.reduce((n, a) => n + a.albums.length, 0);
  console.log(`Successfully generated library.auto.json with ${result.artists.length} artists and ${nAlb} albums.`);
}

main().catch(e => { console.error(e); process.exit(1); });
