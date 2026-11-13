/*
  ساخت library.auto.json + پیدا کردن خودکار کاور آهنگ و عکس خواننده

  هر آهنگی که توی این پوشه‌ها بذاری خودکار به لایبریری اضافه می‌شه:
    assets/music/<Artist>/singles/*.mp3
    assets/music/<Artist>/albums/<AlbumName>/*.mp3
  (mp3 که مستقیم داخل albums باشه هم یه آلبوم هم‌اسم خواننده می‌سازه)

  ترتیب آهنگ‌های آلبوم فقط از روی شماره ابتدای اسم فایل تعیین می‌شه (اسم فایل هر چی باشه مهم نیست).
  فایل‌های بدون شماره می‌رن آخر.

  خروجی = ترکیب library.json (دستی) + پوشه‌ها:
    - همه خواننده‌های library.json می‌مونن (با aliases و description)
    - آهنگ‌های پوشه‌ها اضافه می‌شن، تکراری‌ها فقط یک بار میان

  کاور آلبوم: cover.* / folder.* / front.* / album.* ، یا عکسی هم‌اسم آلبوم، یا اولین عکس داخل پوشه آلبوم.

  منبع‌های عکس (به ترتیب اولویت): SoundCloud ← Spotify ← iTunes ← Deezer
  Spotify و SoundCloud فقط وقتی فعال می‌شن که کلید API بدی:
    SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET        (developer.spotify.com/dashboard)
    SOUNDCLOUD_CLIENT_ID / SOUNDCLOUD_CLIENT_SECRET  (اختیاری)
  iTunes و Deezer کلید نمی‌خوان و همیشه فعالن.

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
const IMG_RE = new RegExp(`\\.(${IMG_EXT.join('|')})$`, 'i');
const RETRY_MS = 30 * 24 * 3600 * 1000;       // «پیدا نشد» رو ۳۰ روز بعد دوباره امتحان می‌کنه
const sleep = ms => new Promise(r => setTimeout(r, ms));
const enc = encodeURIComponent;
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ---------- مقایسه اسم‌ها ---------- */
const norm = s => String(s || '').normalize('NFKD')
  .replace(/[\u0300-\u036f\u064b-\u065f\u200c]/g, '')
  .toLowerCase()
  .replace(/\(.*?\)|\[.*?\]/g, ' ')
  .replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ').trim();

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

// شماره ترک رو از اسم فایل درمیاره، با هر فرمتی:
// "01 - Name", "01. Name", "1) Name", "01 Name", "01_Name", "Track 03", "Artist - 05 - Name", "۰۳ اسم"
function parseTrack(base, artistName) {
  const s = faDigits(base).trim();
  const re = /^(?:track\s*)?(\d{1,3})(?!\d)[\s\-._)\]:]*(.*)$/i;
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

/* ---------- شبکه ---------- */
async function getJson(url, opts = {}) {
  try {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
    return r.ok ? { data: await r.json() } : { error: 'HTTP ' + r.status };
  } catch (e) { return { error: e.message }; }
}

const throttle = ms => { let last = 0; return async () => { const w = last + ms - Date.now(); if (w > 0) await sleep(w); last = Date.now(); }; };
const waitItunes = throttle(3100);            // iTunes حدود ۲۰ درخواست در دقیقه

async function download(url, dest) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) { console.log('  download failed: HTTP ' + r.status); return false; }
    fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
    return true;
  } catch (e) { console.log('  download failed: ' + e.message); return false; }
}

/* ---------- توکن Spotify و SoundCloud (client credentials) ---------- */
let spToken, scToken;
async function spotifyToken() {
  if (spToken !== undefined) return spToken;
  const r = await getJson('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(env.SPOTIFY_CLIENT_ID + ':' + env.SPOTIFY_CLIENT_SECRET).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (r.error) console.log('!! Spotify login failed: ' + r.error + ' - check SPOTIFY_CLIENT_ID / SECRET');
  return (spToken = (r.data && r.data.access_token) || null);
}
async function soundcloudToken() {
  if (scToken !== undefined) return scToken;
  const r = await getJson('https://secure.soundcloud.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: `grant_type=client_credentials&client_id=${enc(env.SOUNDCLOUD_CLIENT_ID)}&client_secret=${enc(env.SOUNDCLOUD_CLIENT_SECRET)}`
  });
  if (r.error) console.log('!! SoundCloud login failed: ' + r.error);
  return (scToken = (r.data && r.data.access_token) || null);
}
const hasSpotify = () => !!(env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET);
const hasSoundcloud = () => !!(env.SOUNDCLOUD_CLIENT_ID && env.SOUNDCLOUD_CLIENT_SECRET);
const scArt = u => u && u.replace('-large', '-t500x500');

/*
  هر منبع دو تابع داره:
   track(artist, title)  ->  { error, list: [{ artist, title, art }] }
   artist(name)          ->  { error, list: [{ name, art }] }
*/
const sources = [
  {
    name: 'Spotify', enabled: hasSpotify,
    async track(artist, title) {
      const tok = await spotifyToken(); if (!tok) return { error: 'no token' };
      const r = await getJson('https://api.spotify.com/v1/search?type=track&limit=10&q=' + enc(`track:${title} artist:${artist}`),
        { headers: { Authorization: 'Bearer ' + tok } });
      return { error: r.error, list: ((r.data && r.data.tracks && r.data.tracks.items) || []).map(x => ({
        artist: (x.artists || []).map(a => a.name).join(', '), title: x.name,
        art: x.album && x.album.images && x.album.images[0] && x.album.images[0].url })) };
    },
    async artist(name) {
      const tok = await spotifyToken(); if (!tok) return { error: 'no token' };
      const r = await getJson('https://api.spotify.com/v1/search?type=artist&limit=5&q=' + enc(name),
        { headers: { Authorization: 'Bearer ' + tok } });
      return { error: r.error, list: ((r.data && r.data.artists && r.data.artists.items) || []).map(x => ({
        name: x.name, art: x.images && x.images[0] && x.images[0].url })) };
    }
  },
  {
    name: 'SoundCloud', enabled: hasSoundcloud,
    async track(artist, title) {
      const tok = await soundcloudToken(); if (!tok) return { error: 'no token' };
      const r = await getJson(`https://api.soundcloud.com/tracks?limit=10&q=${enc(artist + ' ' + title)}`,
        { headers: { Authorization: 'OAuth ' + tok } });
      return { error: r.error, list: (Array.isArray(r.data) ? r.data : []).map(x => ({
        artist: [x.user && x.user.username, x.publisher_metadata && x.publisher_metadata.artist].filter(Boolean).join(' '),
        title: x.title, art: scArt(x.artwork_url) })) };
    },
    async artist(name) {
      const tok = await soundcloudToken(); if (!tok) return { error: 'no token' };
      const r = await getJson(`https://api.soundcloud.com/users?limit=5&q=${enc(name)}`,
        { headers: { Authorization: 'OAuth ' + tok } });
      return { error: r.error, list: (Array.isArray(r.data) ? r.data : []).map(x => ({
        name: x.username, art: scArt(x.avatar_url) })) };
    }
  },
  {
    name: 'iTunes', enabled: () => true,
    async track(artist, title) {
      await waitItunes();
      const r = await getJson('https://itunes.apple.com/search?media=music&entity=song&limit=10&term=' + enc(artist + ' ' + title));
      return { error: r.error, list: ((r.data && r.data.results) || []).map(x => ({
        artist: x.artistName, title: x.trackName,
        art: x.artworkUrl100 && x.artworkUrl100.replace(/\d+x\d+bb/, '1000x1000bb') })) };
    }
    // iTunes عکس خواننده نداره
  },
  {
    name: 'Deezer', enabled: () => true,
    async track(artist, title) {
      const r = await getJson('https://api.deezer.com/search?limit=10&q=' + enc(`artist:"${artist}" track:"${title}"`));
      return { error: r.error, list: ((r.data && r.data.data) || []).map(x => ({
        artist: x.artist && x.artist.name, title: x.title,
        art: x.album && (x.album.cover_xl || x.album.cover_big) })) };
    },
    async artist(name) {
      const r = await getJson('https://api.deezer.com/search/artist?limit=5&q=' + enc(name));
      return { error: r.error, list: ((r.data && r.data.data) || []).map(x => ({
        name: x.name, art: x.picture_xl || x.picture_big })) };
    }
  }
];

// اولویت: SoundCloud اول، بعد Spotify، بعد iTunes و Deezer
const ORDER = ['SoundCloud', 'Spotify', 'iTunes', 'Deezer'];
sources.sort((a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name));

// کاور آهنگ: فقط وقتی اسم خواننده و آهنگ هر دو بخونن قبول می‌شه
async function findCover(artist, title) {
  const errors = [];
  for (const s of sources.filter(s => s.enabled() && s.track)) {
    const { error, list } = await s.track(artist, title);
    if (error) { errors.push(`${s.name}: ${error}`); console.log(`  ${s.name}: ERROR ${error}`); }
    else console.log(`  ${s.name}: ${list.length} results` + (list[0] ? ` (first: "${list[0].artist} - ${list[0].title}")` : ''));
    const hit = (list || []).find(c => c.art && similar(c.artist, artist) && similar(c.title, title));
    if (hit) return { url: hit.art, source: s.name, failed: false };
  }
  return { url: null, failed: errors.length > 0 };
}

// عکس خواننده: فقط وقتی اسم خواننده دقیقاً (نه فقط شبیه) بخونه قبول می‌شه
async function findArtistPhoto(name) {
  const errors = [];
  for (const s of sources.filter(s => s.enabled() && s.artist)) {
    const { error, list } = await s.artist(name);
    if (error) { errors.push(`${s.name}: ${error}`); console.log(`  ${s.name}: ERROR ${error}`); }
    else console.log(`  ${s.name}: ${list.length} results` + (list[0] ? ` (first: "${list[0].name}")` : ''));
    const hit = (list || []).find(c => c.art && norm(c.name) === norm(name));
    if (hit) return { url: hit.art, source: s.name, failed: false };
  }
  return { url: null, failed: errors.length > 0 };
}

/* ---------- پوشه‌ها و فایل‌ها ---------- */
const hasCover = (dir, base) =>
  fs.readdirSync(dir).some(f => new RegExp(`^${escapeRe(base)}\\.(${IMG_EXT.join('|')})$`, 'i').test(f));

// عکس خواننده: photo.* ، یا عکسی به اسم خواننده، یا هر عکسی که داخل پوشه خواننده باشه
function findLocalPhoto(artistPath, artistName) {
  const imgs = fs.readdirSync(artistPath, { withFileTypes: true })
    .filter(d => d.isFile() && IMG_RE.test(d.name)).map(d => d.name).sort();
  return imgs.find(f => /^photo\./i.test(f))
      || imgs.find(f => norm(path.parse(f).name) === norm(artistName))
      || imgs[0] || null;
}

function searchNameOf(artistPath, artistName) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(artistPath, 'info.json'), 'utf8'));
    if (j.searchName) return j.searchName;
  } catch {}
  return artistName;
}

const artistDirs = () => fs.existsSync(musicDir)
  ? fs.readdirSync(musicDir, { withFileTypes: true }).filter(d => d.isDirectory()) : [];

/* ---------- خواندن آلبوم‌ها ---------- */
// dir: پوشه فایل‌ها ، rel: مسیر نسبی برای سایت ، loose: آهنگ‌هایی که مستقیم داخل albums هستن
function buildAlbum(title, dir, rel, artistName, loose) {
  const files = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isFile()).map(d => d.name);
  const mp3s = files.filter(f => f.toLowerCase().endsWith('.mp3'));
  if (!mp3s.length) return null;
  const imgs = files.filter(f => IMG_RE.test(f)).sort(natural);

  const albumCover = imgs.find(f => /^(cover|folder|front|album)\./i.test(f))
    || (loose ? null : (imgs.find(f => norm(path.parse(f).name) === norm(title)) || imgs[0] || null));
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
    const base = path.parse(p.file).name;
    const own = imgs.find(f => new RegExp(`^${escapeRe(base)}\\.(${IMG_EXT.join('|')})$`, 'i').test(f));
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

  // آهنگ‌هایی که مستقیم داخل albums گذاشته شدن
  const loose = buildAlbum(artistName, albumsPath, base, artistName, true);
  if (loose) out.push(loose);

  // هر زیرپوشه = یه آلبوم
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
    } catch (e) { console.log('Error reading library.json'); }
  }

  // ۲. پیدا کردن عکس خواننده و کاور آهنگ‌هایی که ندارن
  if (env.NO_COVERS !== '1') {
    if (typeof fetch !== 'function') {
      console.log(`!! Node ${process.version} has no fetch - Node 18+ is required to download images.`);
    } else {
      let cache = {};
      try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
      if (env.FORCE_COVERS === '1') cache = {};
      const fresh = key => cache[key] && Date.now() - cache[key] < RETRY_MS;
      const stat = { photos: 0, covers: 0, missed: 0 };

      console.log('Sources: ' + sources.filter(s => s.enabled()).map(s => s.name).join(', '));
      if (!hasSoundcloud()) console.log('(SoundCloud is off - set SOUNDCLOUD_CLIENT_ID and SOUNDCLOUD_CLIENT_SECRET to enable it)');
      if (!hasSpotify()) console.log('(Spotify is off - set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to enable it)');

      // ۲-الف) عکس خواننده
      for (const dir of artistDirs()) {
        const artist = dir.name, artistPath = path.join(musicDir, artist);
        if (findLocalPhoto(artistPath, artist)) continue;
        const key = 'photo:' + artist;
        if (fresh(key)) continue;
        const q = searchNameOf(artistPath, artist);
        console.log(`Looking for artist photo: ${q}`);
        const res = await findArtistPhoto(q);
        if (res.url && await download(res.url, path.join(artistPath, 'photo.jpg'))) {
          console.log(`  -> saved photo.jpg (from ${res.source})`);
          stat.photos++; delete cache[key];
        } else {
          stat.missed++;
          if (res.url || res.failed) console.log('  -> connection/API problem, will retry next run');
          else { console.log('  -> no exact match (will not retry for 30 days)'); cache[key] = Date.now(); }
        }
        await sleep(500);
      }

      // ۲-ب) کاور تک‌آهنگ‌ها
      for (const dir of artistDirs()) {
        const artist = dir.name, artistPath = path.join(musicDir, artist);
        const singlesPath = path.join(artistPath, 'singles');
        if (!fs.existsSync(singlesPath)) continue;
        const q = searchNameOf(artistPath, artist);

        for (const file of fs.readdirSync(singlesPath).filter(f => f.toLowerCase().endsWith('.mp3'))) {
          const base = path.parse(file).name;
          if (hasCover(singlesPath, base)) continue;
          const key = `${artist}/${base}`;
          if (fresh(key)) continue;

          console.log(`Looking for cover: ${artist} - ${titleOf(base)}`);
          const res = await findCover(q, titleOf(base));
          if (res.url && await download(res.url, path.join(singlesPath, base + '.jpg'))) {
            console.log(`  -> saved cover (from ${res.source})`);
            stat.covers++; delete cache[key];
          } else {
            stat.missed++;
            if (res.url || res.failed) console.log('  -> connection/API problem, will retry next run');
            else { console.log('  -> no matching result (will not retry for 30 days)'); cache[key] = Date.now(); }
          }
          await sleep(500);
        }
      }

      fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
      console.log(`Done: ${stat.photos} artist photos, ${stat.covers} covers downloaded, ${stat.missed} images not found.`);
    }
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
        const coverFile = all.find(f => new RegExp(`^${escapeRe(base)}\\.(${IMG_EXT.join('|')})$`, 'i').test(f));
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
      photo: sc.photo || man.photo || null,
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
