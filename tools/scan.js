/*
  ساخت library.auto.json + پیدا کردن کاور آهنگ و عکس خواننده

  هر آهنگی که توی این پوشه‌ها بذاری خودکار به لایبریری اضافه می‌شه:
    assets/music/<Artist>/singles/*.mp3
    assets/music/<Artist>/albums/<AlbumName>/*.mp3
  (mp3 که مستقیم داخل albums باشه هم یه آلبوم هم‌اسم خواننده می‌سازه)

  ─── اسم آهنگ از روی اسم فایل ───
    "bache mardom(320).mp3"      ->  bache mardom
    "Amir Tataloo-barzakh.mp3"   ->  barzakh
    "01 - Name", "Track 03", "۰۳ اسم" ->  شماره حذف می‌شه (ترتیب آلبوم از همین شماره‌ست)
    کیفیت (320 / 128kbps)، اسم سایت و عبارت‌هایی مثل (Official Audio) هم پاک می‌شن.

  ─── کاور و عکس: به این ترتیب ───
    ۱. عکسی که خودت گذاشتی (همیشه اولویت داره و هیچ‌وقت عوض یا پاک نمی‌شه)
         تک‌آهنگ:   <نام‌آهنگ>.jpg|png|webp   کنار mp3
         آلبوم:      cover.* / folder.* / front.* / album.* ، عکس هم‌اسم آلبوم، یا اولین عکس پوشه
         خواننده:   photo.* ، عکس هم‌اسم خواننده، یا هر عکس داخل پوشه خواننده
    ۲. کاوری که خود فایل mp3 داخلش داره (ID3v2.2/2.3/2.4)
    ۳. منابع آنلاین، به ترتیب (هر کدوم پیدا نکرد نفر بعدی امتحان می‌شه):
         آهنگ و آلبوم:  Spotify (فقط با کلید) ← Apple Music (iTunes، بدون کلید)
         خواننده:        Spotify ← کاور آلبوم‌های Apple Music (آخرین راه، چون Apple عکس خواننده نمیده)
         عکس خواننده همیشه توی پوشه خود خواننده ذخیره می‌شه:  assets/music/<Artist>/photo.auto.*
       برای پیدا کردن، اسم‌ها از این‌ها جمع می‌شن:
         اسم پوشه، searchName، aliasهای library.json، و تگ‌های ID3 خود mp3ها (TPE1 / TIT2 / TALB)
         پس حتی اگه پوشه فارسی باشه ولی تگ فایل انگلیسی باشه، پیدا می‌شه.
       اگه با اسم خواننده پیدا نشد، فقط با اسم آهنگ هم جستجو می‌کنه و
       اگه اسم آهنگ دقیقاً یکی بود کاورش رو برمی‌داره (با STRICT_COVERS=1 خاموش می‌شه)
       آلبوم: اول با اسم پوشه آلبوم (سال اول اسم مثل "2019 - Name" نادیده گرفته می‌شه) و تگ TALB،
       اگه پیدا نشد از روی اسم اولین آهنگ‌های آلبوم.
    اگه هیچ‌کدوم پیدا نشد، چیزی ذخیره نمی‌شه و خودت بعداً آپلود می‌کنی.

  فایل‌هایی که اسکریپت خودش می‌سازه اسمشون «.auto.» داره، مثلاً  photo.auto.jpg  یا  Song.auto.jpg
  و هر عکسی که خودت بذاری همیشه جلوتر از اونا انتخاب می‌شه.

  Spotify اختیاریه (developer.spotify.com/dashboard):
    SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET
  Apple Music کلید نمی‌خواد و Node 18+ کافیه.

  متغیرهای محیطی:
    NO_COVERS=1              اصلاً دنبال عکس نگرده
    FORCE_COVERS=1           کش «پیدا نشد» رو نادیده بگیره
    STRICT_COVERS=1          جستجوی فقط-با-اسم-آهنگ (تطبیق نرم) خاموش بشه
    COVER_SOURCES=itunes          فقط همین منبع استفاده بشه (spotify,itunes)
    ITUNES_COUNTRIES=us,de,gb     استورهای Apple Music که امتحان بشن (پیش‌فرض us,de)
    NO_ARTIST_ALBUM_FALLBACK=1    کاور آلبوم رو به‌جای عکس خواننده (آخرین راه) استفاده نکنه

  اگه اسم پوشه خواننده فارسیه و توی سرویس‌ها انگلیسی ثبت شده، یکی از این دو کار رو بکن:
    - توی aliases همون خواننده تو library.json اسم انگلیسی‌ش رو بنویس
    - یا داخل پوشه‌اش فایل info.json بساز:  { "searchName": "Hichkas" }
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
const RETRY_MS = 3 * 24 * 3600 * 1000;         // «پیدا نشد» رو ۳ روز بعد دوباره امتحان می‌کنه
const LOOSE = env.STRICT_COVERS !== '1';       // تطبیق نرم‌تر برای کاور
const UA = 'library-auto-builder/2.0 (local music library script)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const enc = encodeURIComponent;
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const dedupe = a => [...new Set(a.filter(Boolean))];

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

/* ---------- اسم‌های هر خواننده (اسم پوشه + aliasهای library.json) ---------- */
const aliasMap = {};
try {
  (JSON.parse(fs.readFileSync(libFile, 'utf8')).artists || []).forEach(a => {
    if (a && a.name) aliasMap[norm(a.name)] = [a.name, ...(Array.isArray(a.aliases) ? a.aliases : [])];
  });
} catch {}
const namesOf = artist => aliasMap[norm(artist)] || [artist];

// آیا اسمی که سرویس داده (یا پیشوند اسم فایل) یکی از اسم‌های این خواننده‌ست؟
function isArtist(candidate, names) {
  const c = norm(candidate);
  if (!c) return false;
  return names.some(n => {
    n = norm(n);
    return n && (c === n || (n.length >= 3 && c.includes(n)) || (c.length >= 3 && n.includes(c)));
  });
}

/* ---------- تمیز کردن اسم آهنگ ---------- */
const SEP = /\s[-\u2013\u2014]\s/;
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

const faDigits = s => s
  .replace(/[\u06f0-\u06f9]/g, c => c.charCodeAt(0) - 0x06f0)
  .replace(/[\u0660-\u0669]/g, c => c.charCodeAt(0) - 0x0660);

const cleanTitle = s => String(s)
  .replace(/_/g, ' ')
  .replace(/(?:https?:\/\/|www\.)\S+/gi, ' ')
  .replace(/[(\[{][^)\]}]*\.(?:com|ir|net|org)\b[^)\]}]*[)\]}]/gi, ' ')
  .replace(/[(\[{]\s*\d{2,3}\s*(?:kbps|k)?\s*[)\]}]/gi, ' ')
  .replace(/[(\[{][^)\]}]*\b(?:official|lyrics?|audio|video|mp3|remaster(?:ed)?|hq|hd|320|256|192|128)\b[^)\]}]*[)\]}]/gi, ' ')
  .replace(/\b(?:320|256|192|128)\s*kbps\b/gi, ' ')
  .replace(/[\s\-\u2013\u2014]+(?:320|256|192|128)\s*$/g, ' ')
  .replace(/\s{2,}/g, ' ')
  .replace(/^[\s\-\u2013\u2014._]+|[\s\-\u2013\u2014._]+$/g, '')
  .trim();

function stripArtist(s, names) {
  const re = /\s*[-\u2013\u2014:]\s*/g;
  let m;
  while ((m = re.exec(s))) {
    const left = s.slice(0, m.index).trim();
    const rest = s.slice(m.index + m[0].length).trim();
    if (left && rest && isArtist(left, names)) return rest;
  }
  return s;
}

function parseTrack(base, artist) {
  const names = namesOf(artist);
  const numRe = /^(?:track\s*)?(\d{1,3})(?!\d)(?:[\s\-._)\]:]+|$)(.*)$/i;
  const orig = cleanTitle(faDigits(base));
  let s = orig, num = null;
  const takeNum = () => {
    const m = s.match(numRe);
    if (!m) return false;
    num = parseInt(m[1], 10);
    s = m[2].trim();
    return true;
  };

  takeNum();
  s = stripArtist(s, names);
  if (num === null && takeNum()) s = stripArtist(s, names);       // "Artist - 05 - Name"

  if (num === null && s === orig && SEP.test(s)) s = s.split(SEP).slice(1).join(' - ');

  s = cleanTitle(s);
  if (!s) s = (num !== null ? 'Track ' + num : orig) || base;
  return { num, title: s };
}
const titleOf = (base, artist) => parseTrack(base, artist).title;

// نسخه‌های مختلف یک اسم برای جستجو: اصلی، بدون feat.، اسم تگ ID3 (حداکثر ۳ تا)
const FEAT_RE = /\s*[(\[]\s*(?:feat|ft|featuring)\.?[^)\]]*[)\]]|\s+(?:feat|ft|featuring)\.?\s.*$/i;
function titleVariants(...list) {
  const out = [];
  for (const t of list) {
    if (!t) continue;
    for (const v of [t, t.replace(FEAT_RE, '').trim()]) {
      if (v && !out.some(o => o.toLowerCase() === v.toLowerCase())) out.push(v);
    }
  }
  return out.slice(0, 3);
}

/* ---------- عکس‌ها: کدوم فایل مال خودته و کدوم مال اسکریپت ---------- */
const isImg = f => IMG_RE.test(f);
const isAuto = f => AUTO_RE.test(f);

function findImgFor(files, base) {
  const own = new RegExp(`^${escapeRe(base)}\\.(${EXT_GROUP})$`, 'i');
  const auto = new RegExp(`^${escapeRe(base)}\\.auto\\.(${EXT_GROUP})$`, 'i');
  return files.find(f => own.test(f)) || files.find(f => auto.test(f)) || null;
}

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

/* ---------- خواندن ID3 داخل خود mp3 (کاور + تگ‌های متنی، بدون نیاز به پکیج) ---------- */
const syncsafe = (b, o) => ((b[o] & 127) << 21) | ((b[o + 1] & 127) << 14) | ((b[o + 2] & 127) << 7) | (b[o + 3] & 127);
const TEXT_FRAMES = { TIT2: 'title', TT2: 'title', TPE1: 'artist', TP1: 'artist', TALB: 'album', TAL: 'album' };

function sniffExt(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function decodeText(d, e) {
  try {
    let b = Buffer.from(d);
    if (e === 1 || e === 2) {
      let be = e === 2;
      if (b[0] === 0xff && b[1] === 0xfe) { b = b.subarray(2); be = false; }
      else if (b[0] === 0xfe && b[1] === 0xff) { b = b.subarray(2); be = true; }
      b = Buffer.from(b.subarray(0, b.length & ~1));
      if (be) b.swap16();
      return b.toString('utf16le').split('\u0000')[0].trim();
    }
    return (e === 3 ? b.toString('utf8') : b.toString('latin1')).split('\u0000')[0].trim();
  } catch { return ''; }
}

function parsePicture(d, ver) {
  let i = 0;
  const textEnc = d[i++];
  if (ver === 2) i += 3;
  else { const e = d.indexOf(0, i); if (e < 0) return null; i = e + 1; }
  const type = d[i++];
  if (textEnc === 1 || textEnc === 2) {
    while (i + 1 < d.length && !(d[i] === 0 && d[i + 1] === 0)) i += 2;
    i += 2;
  } else { const e = d.indexOf(0, i); if (e < 0) return null; i = e + 1; }
  const img = d.slice(i), ext = sniffExt(img);
  return ext ? { type, img, ext } : null;
}

// خروجی: { cover: {img, ext} | null, tags: {title, artist, album} }
function readId3(file) {
  const out = { cover: null, tags: {} };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const h = Buffer.alloc(10);
    if (fs.readSync(fd, h, 0, 10, 0) < 10 || h.toString('latin1', 0, 3) !== 'ID3') return out;
    const ver = h[3], flags = h[5], size = syncsafe(h, 6);
    if (ver < 2 || ver > 4 || !size) return out;
    const len = Math.min(size, 32 * 1024 * 1024);
    let buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 10);
    if (flags & 0x80) {
      const arr = [];
      for (let i = 0; i < buf.length; i++) { arr.push(buf[i]); if (buf[i] === 0xff && buf[i + 1] === 0) i++; }
      buf = Buffer.from(arr);
    }
    let pos = 0;
    if ((flags & 0x40) && ver >= 3) pos = ver === 4 ? syncsafe(buf, 0) : buf.readUInt32BE(0) + 4;
    const hl = ver === 2 ? 6 : 10, found = [];
    while (pos + hl <= buf.length && buf[pos] !== 0) {
      const id = buf.toString('latin1', pos, pos + (ver === 2 ? 3 : 4));
      const fsz = ver === 2 ? (buf[pos + 3] << 16) | (buf[pos + 4] << 8) | buf[pos + 5]
                : ver === 4 ? syncsafe(buf, pos + 4) : buf.readUInt32BE(pos + 4);
      if (fsz <= 0 || pos + hl + fsz > buf.length) break;
      const isPic = id === 'APIC' || id === 'PIC';
      if (isPic || TEXT_FRAMES[id]) {
        const d = buf.slice(pos + hl, pos + hl + fsz);
        let skip = false, off = 0;
        const fl = ver >= 3 ? buf[pos + 9] : 0;
        if (ver === 4) { if (fl & 0x0c) skip = true; if (fl & 0x40) off += 1; if (fl & 0x01) off += 4; }
        if (ver === 3) { if (fl & 0xc0) skip = true; if (fl & 0x20) off += 1; }
        if (!skip) {
          if (isPic) {
            const p = parsePicture(d.slice(off), ver);
            if (p) found.push(p);
          } else {
            const key = TEXT_FRAMES[id];
            const t = decodeText(d.slice(off + 1), d[off]);
            if (t && !out.tags[key]) out.tags[key] = t;
          }
        }
      }
      pos += hl + fsz;
    }
    out.cover = found.find(p => p.type === 3) || found[0] || null;
  } catch {}
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  return out;
}

// کاور داخل mp3 رو کنار فایل ذخیره می‌کنه. چیزی رو overwrite نمی‌کنه.
function saveCover(c, destBase) {
  if (!c) return null;
  const dest = `${destBase}.auto.${c.ext}`;
  if (fs.existsSync(dest)) return dest;
  fs.writeFileSync(dest, c.img);
  return dest;
}

// اسم‌های خواننده از روی تگ‌های ID3 (مثلاً "A feat. B" -> A, B). اسم سایت و Various حذف می‌شن
function namesFromTag(v) {
  if (!v) return [];
  return v.split(/\s*(?:,|;|&|\/|\bfeat\.?|\bft\.?|\bfeaturing\b|\bx\b)\s*/i)
    .map(s => s.trim())
    .filter(s => s.length >= 2 && s.length <= 60 && !/various|unknown|\.(?:com|ir|net|org)\b|www\./i.test(s));
}

// چند mp3 اول هر خواننده رو می‌خونه تا اسم‌های بیشتری (مثلاً انگلیسی) از تگ‌ها دربیاره
const tagNamesCache = new Map();
function artistTagNames(artistPath) {
  if (tagNamesCache.has(artistPath)) return tagNamesCache.get(artistPath);
  const files = [];
  const add = dir => { try { filesIn(dir).filter(f => /\.mp3$/i.test(f)).sort(natural).slice(0, 3).forEach(f => files.push(path.join(dir, f))); } catch {} };
  add(path.join(artistPath, 'singles'));
  const ap = path.join(artistPath, 'albums');
  if (fs.existsSync(ap)) {
    add(ap);
    fs.readdirSync(ap, { withFileTypes: true }).filter(d => d.isDirectory()).slice(0, 3).forEach(d => add(path.join(ap, d.name)));
  }
  const names = dedupe(files.slice(0, 5).flatMap(f => namesFromTag(readId3(f).tags.artist)));
  tagNamesCache.set(artistPath, names);
  return names;
}

/* ---------- شبکه ---------- */
async function getJson(url, opts = {}, tries = 3, codes = [429]) {
  try {
    const { headers, ...rest } = opts;
    const r = await fetch(url, { ...rest, headers: { 'User-Agent': UA, ...(headers || {}) }, signal: AbortSignal.timeout(15000) });
    if (codes.includes(r.status) && tries > 1) {
      const w = Math.min(+r.headers.get('retry-after') || 10, 60);
      console.log(`  rate limited, waiting ${w}s...`);
      await sleep(w * 1000);
      return getJson(url, opts, tries - 1, codes);
    }
    return r.ok ? { data: await r.json() } : { error: 'HTTP ' + r.status };
  } catch (e) { return { error: e.message }; }
}

// عکس رو دانلود می‌کنه و به شکل <destBase>.auto.<ext> ذخیره می‌کنه (هیچ فایل موجودی رو عوض نمی‌کنه)
async function download(url, destBase) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    const ext = sniffExt(buf);
    if (!ext || buf.length < 1500) return null;
    const dest = `${destBase}.auto.${ext}`;
    if (fs.existsSync(dest)) return dest;
    fs.writeFileSync(dest, buf);
    return dest;
  } catch { return null; }
}

// چند آدرس عکس (از بزرگ به کوچک) رو به ترتیب امتحان می‌کنه
async function saveFrom(urls, destBase) {
  for (const u of urls) {
    const f = await download(u, destBase);
    if (f) return f;
  }
  console.log('  download failed for all image URLs of this match');
  return null;
}

const last = {};
async function wait(name, ms) {
  const d = Date.now() - (last[name] || 0);
  if (d < ms) await sleep(ms - d);
  last[name] = Date.now();
}

/* ---------- منابع آنلاین ---------- */
// هر منبع: queries(kind, names, title) لیست جستجوها، و fetch(kind, q) که {items:[{title, artists, imgs, exact?}]} برمی‌گردونه
// kind یکی از track / album / artist
const hasSpotify = () => !!(env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET);
const latinFirst = names => names.find(n => /[a-z]/i.test(n)) || names[0];
const qClean = s => String(s).replace(/["\\]/g, ' ').trim();

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

const itArt = u => {
  if (!u) return [];
  const re = /\/\d+x\d+[a-z]*\.(?:jpg|png|webp)$/i;
  return dedupe([u.replace(re, '/1400x1400bb.jpg'), u.replace(re, '/600x600bb.jpg'), u]);
};
const itCountries = () => (env.ITUNES_COUNTRIES || 'us,de').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const PROVIDERS = {
  spotify: {
    on: hasSpotify,
    queries(kind, names, t) {
      const p = latinFirst(names);
      if (kind === 'track') return [`track:"${qClean(t)}" artist:"${qClean(p)}"`, `${t} ${p}`, t];
      if (kind === 'album') return [`album:"${qClean(t)}" artist:"${qClean(p)}"`, `${t} ${p}`, t];
      return dedupe([`artist:"${qClean(p)}"`, ...names.slice(0, 4)]);
    },
    async fetch(kind, q) {
      const tok = await spotifyToken();
      if (!tok) return { error: 'no token', fatal: true };
      await wait('spotify', 300);
      const r = await getJson(`https://api.spotify.com/v1/search?type=${kind}&limit=10&q=${enc(q)}`, { headers: { Authorization: 'Bearer ' + tok } });
      if (r.error) return r;
      const d = r.data || {};
      const img = x => (x.images && x.images[0] && x.images[0].url) || (x.album && x.album.images && x.album.images[0] && x.album.images[0].url);
      const arts = x => (x.artists || []).map(a => a.name);
      const list = (d[kind + 's'] && d[kind + 's'].items) || [];
      return { items: list.filter(x => x && img(x)).map(x => ({ title: x.name, artists: kind === 'artist' ? [x.name] : arts(x), imgs: [img(x)] })) };
    }
  },

  itunes: {   // Apple Music (iTunes Search API، بدون کلید)
    on: () => true,
    queries(kind, names, t) {
      const p = latinFirst(names), cs = itCountries();
      if (kind === 'artist') {
        if (env.NO_ARTIST_ALBUM_FALLBACK === '1') return [];
        return dedupe(names.slice(0, 3)).map(n => ({ term: n, country: cs[0] }));
      }
      return [...cs.map(c => ({ term: `${p} ${t}`, country: c })), { term: t, country: cs[0] }];
    },
    async fetch(kind, q) {
      await wait('itunes', 1500);
      const entity = kind === 'track' ? 'song' : 'album';
      const r = await getJson(`https://itunes.apple.com/search?term=${enc(q.term)}&media=music&entity=${entity}&limit=25&country=${q.country}`, {}, 3, [429, 403]);
      if (r.error) return r;
      const items = ((r.data && r.data.results) || []).filter(x => x.artworkUrl100).map(x => ({
        title: kind === 'track' ? x.trackName : kind === 'album' ? x.collectionName : x.artistName,
        artists: [x.artistName],
        imgs: itArt(x.artworkUrl100)
      }));
      return { items };
    }
  }
};

const ORDER = {
  track:  ['spotify', 'itunes'],
  album:  ['spotify', 'itunes'],
  artist: ['spotify', 'itunes']
};
const ONLY = (env.COVER_SOURCES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const enabled = n => !!PROVIDERS[n] && PROVIDERS[n].on() && (!ONLY.length || ONLY.includes(n));
const activeSources = () => Object.keys(PROVIDERS).filter(enabled);

function matchItem(kind, items, names, title) {
  if (kind === 'artist') {
    return items.find(x => x.exact ? names.some(n => norm(n) === norm(x.title)) : isArtist(x.title, names));
  }
  return items.filter(x => titleMatch(x.title, title))
    .find(x => (x.artists || []).some(a => isArtist(a, names)));
}

const label = x => `${(x.artists || []).filter(Boolean).join(', ')} - ${x.title}`;

// جستجو توی همه منابع به ترتیب. اول تطبیق دقیق (اسم + خواننده) روی همه منابع،
// اگه loose باشه و هیچی پیدا نشد، تطبیق فقط-با-اسم-دقیق آهنگ روی نتایجی که همین الان گرفته.
async function lookup(kind, { names, titles, dest, loose }) {
  const pool = [];
  let okCalls = 0, dlFailed = false;
  const list = kind === 'artist' ? [null] : titles;

  for (const pn of ORDER[kind]) {
    if (!enabled(pn)) continue;
    const P = PROVIDERS[pn];
    let dead = false;
    for (const title of list) {
      if (dead) break;
      const qs = P.queries(kind, names, title);
      for (let i = 0; i < qs.length; i++) {
        const r = await P.fetch(kind, qs[i]);
        if (r.error) {
          console.log(`  [${pn}] ERROR ${r.error}`);
          if (r.fatal) { dead = true; break; }
          continue;
        }
        okCalls++;
        const items = r.items.filter(x => x.imgs && x.imgs.length);
        console.log(`  [${pn}] ${qs.length > 1 ? `${i + 1}/${qs.length} ` : ''}${items.length} results` + (items[0] ? ` (first: "${label(items[0])}")` : ''));
        const hit = matchItem(kind, items, names, title);
        if (hit) {
          console.log(`  matched [${pn}]: "${label(hit)}"`);
          const file = await saveFrom(hit.imgs, dest);
          if (file) return { file, source: pn, failed: false };
          dlFailed = true;
        }
        if (kind !== 'artist' && i === qs.length - 1) pool.push({ pn, title, items });
      }
    }
  }

  if (loose && kind !== 'artist') {
    for (const { pn, title, items } of pool) {
      const hit = items.find(x => norm(x.title) === norm(title));
      if (hit) {
        console.log(`  loose match [${pn}]: "${label(hit)}"`);
        const file = await saveFrom(hit.imgs, dest);
        if (file) return { file, source: pn + ' (loose)', failed: false };
        dlFailed = true;
      }
    }
  }
  return { file: null, source: null, failed: okCalls === 0 || dlFailed };
}

// اسم پوشه آلبوم رو برای جستجو تمیز می‌کنه: "2019 - Barzakh (320)" -> "Barzakh"
const albumQueryOf = t => cleanTitle(t).replace(/^\(?\d{4}\)?\s*[-\u2013\u2014._]+\s*/, '').trim();

// کاور آلبوم: اول خود آلبوم، بعد از روی اسم اولین آهنگ‌ها
async function lookupAlbum(names, albumTitles, trackTitles, dest) {
  let allFailed = true;
  if (albumTitles.length) {
    const r = await lookup('album', { names, titles: albumTitles, dest, loose: LOOSE });
    if (r.file) return r;
    if (!r.failed) allFailed = false;
  }
  for (const t of (trackTitles || []).slice(0, 2)) {
    console.log(`  trying album cover via track: ${t}`);
    const r = await lookup('track', { names, titles: [t], dest, loose: false });
    if (r.file) return r;
    if (!r.failed) allFailed = false;
  }
  return { file: null, source: null, failed: allFailed };
}

/* ---------- پوشه‌ها و فایل‌ها ---------- */
const artistNames = (artist, searchName) =>
  [...new Set([searchName, artist, ...namesOf(artist)].filter(Boolean))];

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
function buildAlbum(title, dir, rel, artistName, loose) {
  const files = filesIn(dir);
  const mp3s = files.filter(f => f.toLowerCase().endsWith('.mp3'));
  if (!mp3s.length) return null;
  const imgs = files.filter(isImg).sort(natural);

  const pick = list => list.find(f => /^(cover|folder|front|album)\./i.test(f))
    || (loose ? null : (list.find(f => norm(path.parse(f).name.replace(/\.auto$/i, '')) === norm(title)) || list[0] || null));
  const albumCover = pick(imgs.filter(f => !isAuto(f))) || pick(imgs.filter(isAuto));
  const coverPath = albumCover ? `${rel}/${albumCover}` : null;

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

  // ۲. کاور و عکس: اول کاور داخل mp3، بعد منابع آنلاین
  if (env.NO_COVERS !== '1') {
    let cache = {};
    try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
    if (env.FORCE_COVERS === '1') cache = {};
    const fresh = key => cache[key] && Date.now() - cache[key] < RETRY_MS;
    const stat = { embedded: 0, photos: 0, covers: 0, albumCovers: 0, missed: 0, src: {} };
    const bump = s => { stat.src[s] = (stat.src[s] || 0) + 1; };

    const online = typeof fetch === 'function';
    if (!online) console.log(`!! Node ${process.version} has no fetch - Node 18+ is required for online sources (embedded mp3 covers still work).`);
    else console.log('Sources: embedded mp3 covers + ' + activeSources().join(', ') + (LOOSE ? '' : ' [strict]')
      + (hasSpotify() ? '' : '  (Spotify off - set SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET to add it)'));

    const report = (res, key, okMsg, okStat) => {
      if (res.file) {
        console.log(`  -> saved ${path.basename(res.file)} (from ${res.source})`);
        stat[okStat]++; bump(res.source); delete cache[key];
      } else {
        stat.missed++;
        if (res.failed) console.log('  -> connection/API problem, will retry next run');
        else { console.log(`  -> no match in any source (will not retry for 3 days, upload it yourself)`); cache[key] = Date.now(); }
      }
    };

    // ۲-الف) کاور آلبوم‌هایی که هیچ عکسی ندارن
    for (const dir of artistDirs()) {
      const artist = dir.name, artistPath = path.join(musicDir, artist);
      const albumsPath = path.join(artistPath, 'albums');
      if (!fs.existsSync(albumsPath)) continue;
      const baseNames = artistNames(artist, searchNameOf(artistPath, artist));
      const dirs = [albumsPath, ...fs.readdirSync(albumsPath, { withFileTypes: true })
        .filter(d => d.isDirectory()).map(d => path.join(albumsPath, d.name))];
      for (const d of dirs) {
        const files = filesIn(d);
        const mp3s = files.filter(f => f.toLowerCase().endsWith('.mp3')).sort(natural);
        if (!mp3s.length) continue;
        if (files.some(isImg)) continue;

        let done = false, tagAlbum = null, tagArtists = [];
        for (const mp3 of mp3s) {
          const id3 = readId3(path.join(d, mp3));
          if (id3.cover && saveCover(id3.cover, path.join(d, 'cover'))) {
            console.log(`Album cover taken from mp3: ${path.relative(musicDir, d)}`);
            stat.embedded++;
            done = true;
            break;
          }
          if (!tagAlbum && id3.tags.album) tagAlbum = id3.tags.album;
          tagArtists.push(...namesFromTag(id3.tags.artist));
        }
        if (done || !online) continue;

        const isLoose = d === albumsPath;
        const albumTitle = isLoose ? null : path.basename(d);
        const key = `album:${artist}/${albumTitle || ''}`;
        if (fresh(key)) continue;
        const names = dedupe([...baseNames, ...artistTagNames(artistPath), ...tagArtists]);
        const albumTitles = titleVariants(albumTitle ? albumQueryOf(albumTitle) : '', tagAlbum ? cleanTitle(tagAlbum) : '');
        const trackTitles = mp3s
          .map(f => ({ f, ...parseTrack(path.parse(f).name, artist) }))
          .sort((a, b) => (a.num === null) - (b.num === null) || (a.num || 0) - (b.num || 0))
          .map(p => p.title);
        console.log(`Looking for album cover: ${names[0]} - ${albumTitle || '(loose tracks)'}`);
        const res = await lookupAlbum(names, albumTitles, trackTitles, path.join(d, 'cover'));
        report(res, key, '', 'albumCovers');
      }
    }

    // ۲-ب) عکس خواننده
    if (online) {
      for (const dir of artistDirs()) {
        const artist = dir.name, artistPath = path.join(musicDir, artist);
        if (findLocalPhoto(artistPath, artist)) continue;
        const key = 'photo:' + artist;
        if (fresh(key)) continue;
        const names = dedupe([...artistNames(artist, searchNameOf(artistPath, artist)), ...artistTagNames(artistPath)]);
        console.log(`Looking for artist photo: ${names[0]}`);
        const res = await lookup('artist', { names, titles: [null], dest: path.join(artistPath, 'photo'), loose: false });
        report(res, key, '', 'photos');
      }
    }

    // ۲-پ) کاور تک‌آهنگ‌ها: کاور داخل mp3 ← منابع آنلاین
    for (const dir of artistDirs()) {
      const artist = dir.name, artistPath = path.join(musicDir, artist);
      const singlesPath = path.join(artistPath, 'singles');
      if (!fs.existsSync(singlesPath)) continue;
      const baseNames = artistNames(artist, searchNameOf(artistPath, artist));

      for (const file of fs.readdirSync(singlesPath).filter(f => f.toLowerCase().endsWith('.mp3'))) {
        const base = path.parse(file).name;
        if (findImgFor(fs.readdirSync(singlesPath), base)) continue;

        const title = titleOf(base, artist);
        const id3 = readId3(path.join(singlesPath, file));
        if (id3.cover && saveCover(id3.cover, path.join(singlesPath, base))) {
          console.log(`Cover taken from mp3: ${artist} - ${title}`);
          stat.embedded++;
          continue;
        }
        if (!online) continue;

        const key = `${artist}/${base}`;
        if (fresh(key)) continue;
        const names = dedupe([...baseNames, ...artistTagNames(artistPath), ...namesFromTag(id3.tags.artist)]);
        const titles = titleVariants(title, id3.tags.title ? cleanTitle(id3.tags.title) : '');
        console.log(`Looking for cover: ${names[0]} - ${title}`);
        const res = await lookup('track', { names, titles, dest: path.join(singlesPath, base), loose: LOOSE });
        report(res, key, '', 'covers');
      }
    }

    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
    const srcTxt = Object.entries(stat.src).map(([k, v]) => `${k}: ${v}`).join(', ');
    console.log(`Done: ${stat.embedded} covers from mp3 files, ${stat.photos} artist photos, ${stat.covers} single covers and ${stat.albumCovers} album covers online${srcTxt ? ' (' + srcTxt + ')' : ''}, ${stat.missed} not found.`);
  }

  // ۳. خواندن آهنگ‌ها از پوشه‌ها و ترکیب با library.json
  let manualArtists = [];
  try {
    manualArtists = (JSON.parse(fs.readFileSync(libFile, 'utf8')).artists || []).filter(a => a && a.name);
  } catch {}

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
          title: titleOf(base, artistName),
          artist: artistName,
          audio: `music/${artistName}/singles/${file}`,
          cover: coverFile ? `music/${artistName}/singles/${coverFile}` : null
        });
      });
    }
    obj.albums = readAlbums(artistPath, artistName);
    scanned[norm(artistName)] = obj;
  });

  const audioKey = p => norm(path.parse(String(p || '')).name);
  const fixSingle = (s, artistName) => {
    if (typeof s === 'string') {
      return { title: titleOf(path.parse(s).name, artistName), artist: artistName, audio: s, cover: null };
    }
    return s && s.audio ? s : null;
  };

  const result = { artists: [] };
  const used = new Set();

  manualArtists.forEach(man => {
    const key = norm(man.name);
    used.add(key);
    const sc = scanned[key] || { singles: [], albums: [], photo: null };

    const have = new Set(sc.singles.map(s => audioKey(s.audio)));
    const singles = (Array.isArray(man.singles) ? man.singles : [])
      .map(s => fixSingle(s, man.name))
      .filter(s => s && !have.has(audioKey(s.audio)))
      .concat(sc.singles);

    const manAlbums = (Array.isArray(man.albums) ? man.albums : [])
      .filter(a => a && typeof a === 'object' && Array.isArray(a.tracks));
    const manTitles = new Set(manAlbums.map(a => norm(a.title)));
    const albums = manAlbums.concat(sc.albums.filter(a => !manTitles.has(norm(a.title))));

    const { singles: _s, albums: _a, ...rest } = man;
    result.artists.push({
      ...rest,
      name: man.name,
      photo: man.photo || sc.photo || null,
      description: man.description || 'ARTIST',
      singles,
      albums
    });
  });

  Object.keys(scanned).filter(k => !used.has(k)).forEach(k => {
    const a = scanned[k];
    if (a.singles.length || a.albums.length) result.artists.push(a);
  });

  fs.writeFileSync(path.join(assetsDir, 'library.auto.json'), JSON.stringify(result, null, 2));
  const nAlb = result.artists.reduce((n, a) => n + a.albums.length, 0);
  console.log(`Successfully generated library.auto.json with ${result.artists.length} artists and ${nAlb} albums.`);
}

main().catch(e => { console.error(e); process.exit(1); });
