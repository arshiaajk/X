/*
  ساخت library.auto.json + پیدا کردن خودکار کاور آهنگ و عکس خواننده

  منبع‌های عکس (به ترتیب اولویت): SoundCloud ← Spotify ← iTunes ← Deezer
  SoundCloud منبع اصلیه؛ اگه چیزی پیدا نکرد نوبت Spotify و بعد بقیه می‌شه.
  Spotify و SoundCloud فقط وقتی فعال می‌شن که کلید API بدی (رایگانه، پایین‌تر توضیح داده شده):
    SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET        (developer.spotify.com/dashboard)
    SOUNDCLOUD_CLIENT_ID / SOUNDCLOUD_CLIENT_SECRET  (اختیاری)
  iTunes و Deezer کلید نمی‌خوان و همیشه فعالن.

  آهنگ از منبع‌های «باز» (فقط آهنگ‌های با لایسنس Creative Commons / دامنه عمومی):
    Jamendo         JAMENDO_CLIENT_ID   (رایگان: devportal.jamendo.com)
    Internet Archive  بدون کلید، فقط آیتم‌هایی که لایسنس CC یا public domain دارن
  آهنگ‌ها داخل پوشه singles هر خواننده ذخیره می‌شن، کنار هر کدوم یه فایل «.license.json» با لایسنس و لینک منبع.

  متغیرهای محیطی دیگر:
    NO_COVERS=1       اصلاً دنبال عکس نگرده
    NO_OPEN_MUSIC=1   دنبال آهنگ باز نگرده
    FORCE_COVERS=1    کش «پیدا نشد» رو نادیده بگیره (برای آهنگ‌ها: FORCE_OPEN=1)
    OPEN_MAX=20       حداکثر تعداد آهنگ جدید برای هر خواننده در هر اجرا

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

/* ---------- آهنگ از منبع‌های باز (CC / public domain) ---------- */
const OPEN_RECHECK_MS = 7 * 24 * 3600 * 1000;   // هر خواننده هفته‌ای یک بار بررسی می‌شه
const OPEN_MAX = parseInt(env.OPEN_MAX, 10) || 20;
const MAX_BYTES = 40 * 1024 * 1024;
const safeName = s => String(s).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
const isMp3 = b => b.length > 10000 && ((b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0));
const OPEN_LICENSE_RE = /creativecommons\.org|publicdomain/i;

async function downloadMp3(url, dest) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(180000), redirect: 'follow' });
    if (!r.ok) { console.log('  download failed: HTTP ' + r.status); return false; }
    if (+r.headers.get('content-length') > MAX_BYTES) { console.log('  skipped: file too large'); return false; }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_BYTES || !isMp3(buf)) { console.log('  skipped: not a valid mp3'); return false; }
    fs.writeFileSync(dest, buf);
    return true;
  } catch (e) { console.log('  download failed: ' + e.message); return false; }
}

// هر منبع باز: tracks(artistName) -> { error, list: [{ title, url, cover, license, page, source, by }] }
const openSources = [
  {
    name: 'Jamendo', enabled: () => !!env.JAMENDO_CLIENT_ID,
    async tracks(name) {
      const r = await getJson('https://api.jamendo.com/v3.0/tracks/?format=json&limit=50&audiodlformat=mp32&order=popularity_total'
        + '&client_id=' + enc(env.JAMENDO_CLIENT_ID) + '&artist_name=' + enc(name));
      if (r.error) return { error: r.error, list: [] };
      return { list: ((r.data && r.data.results) || [])
        .filter(x => norm(x.artist_name) === norm(name) && x.audiodownload_allowed && x.audiodownload && x.license_ccurl)
        .map(x => ({ title: x.name, url: x.audiodownload, cover: x.image, license: x.license_ccurl,
                     page: x.shareurl, source: 'Jamendo', by: x.artist_name })) };
    }
  },
  {
    name: 'Internet Archive', enabled: () => true,
    async tracks(name) {
      const q = `creator:"${name.replace(/"/g, '')}" AND mediatype:audio`;
      const s = await getJson('https://archive.org/advancedsearch.php?output=json&rows=15&fl[]=identifier&fl[]=creator&fl[]=licenseurl&q=' + enc(q));
      if (s.error) return { error: s.error, list: [] };
      const out = [];
      for (const d of ((s.data && s.data.response && s.data.response.docs) || [])) {
        const creators = [].concat(d.creator || []);
        const lic = [].concat(d.licenseurl || []).find(u => OPEN_LICENSE_RE.test(u));
        if (!lic || !creators.some(c => norm(c) === norm(name))) continue;     // لایسنس باز + اسم دقیق خواننده
        const m = await getJson('https://archive.org/metadata/' + enc(d.identifier));
        for (const f of ((m.data && m.data.files) || [])) {
          if (!/\.mp3$/i.test(f.name) || f.source === 'metadata' || !/mp3/i.test(f.format || '')) continue;
          out.push({ title: f.title || path.parse(f.name).name, url: `https://archive.org/download/${enc(d.identifier)}/${enc(f.name)}`,
                     cover: null, license: lic, page: 'https://archive.org/details/' + d.identifier, source: 'Internet Archive', by: name });
        }
        await sleep(300);
      }
      return { list: out };
    }
  }
];

async function fetchOpenMusic(artist, artistPath, singlesPath, searchName) {
  let added = 0, anyError = false;
  const seen = new Set();
  for (const s of openSources.filter(s => s.enabled())) {
    if (added >= OPEN_MAX) break;
    const { error, list } = await s.tracks(searchName);
    if (error) { anyError = true; console.log(`  ${s.name}: ERROR ${error}`); continue; }
    console.log(`  ${s.name}: ${list.length} open-licensed tracks`);
    for (const tr of list) {
      if (added >= OPEN_MAX) break;
      const title = safeName(tr.title);
      if (!title || seen.has(norm(title))) continue;
      seen.add(norm(title));
      const base = `${artist} - ${title}`;
      if (fs.existsSync(path.join(singlesPath, base + '.mp3'))) continue;        // قبلاً گرفته شده
      if (fs.readdirSync(singlesPath).some(f => f.toLowerCase().endsWith('.mp3') && similar(titleOf(path.parse(f).name), title))) continue;
      console.log(`  downloading: ${title}  [${tr.license}]`);
      if (!(await downloadMp3(tr.url, path.join(singlesPath, base + '.mp3')))) { anyError = true; continue; }
      fs.writeFileSync(path.join(singlesPath, base + '.license.json'),
        JSON.stringify({ license: tr.license, source: tr.source, url: tr.page, by: tr.by }, null, 2));
      if (tr.cover && !hasCover(singlesPath, base)) await download(tr.cover, path.join(singlesPath, base + '.jpg'));
      added++;
      await sleep(500);
    }
  }
  return { added, anyError };
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
  if (env.NO_COVERS !== '1' || env.NO_OPEN_MUSIC !== '1') {
    if (typeof fetch !== 'function') {
      console.log(`!! Node ${process.version} has no fetch - Node 18+ is required to download images and music.`);
    } else {
      let cache = {};
      try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
      if (env.FORCE_COVERS === '1') cache = {};
      const fresh = key => cache[key] && Date.now() - cache[key] < RETRY_MS;
      const stat = { photos: 0, covers: 0, missed: 0, songs: 0 };

      // ۲-پ) آهنگ از منبع‌های باز
      if (env.NO_OPEN_MUSIC !== '1') {
        console.log('Open music sources: ' + openSources.filter(s => s.enabled()).map(s => s.name).join(', '));
        if (!env.JAMENDO_CLIENT_ID) console.log('(Jamendo is off - set JAMENDO_CLIENT_ID to enable it)');
        for (const dir of artistDirs()) {
          const artist = dir.name, artistPath = path.join(musicDir, artist);
          const singlesPath = path.join(artistPath, 'singles');
          const key = 'open:' + artist;
          if (env.FORCE_OPEN !== '1' && cache[key] && Date.now() - cache[key] < OPEN_RECHECK_MS) continue;
          if (!fs.existsSync(singlesPath)) fs.mkdirSync(singlesPath, { recursive: true });
          console.log(`Searching open-licensed music: ${artist}`);
          const res = await fetchOpenMusic(artist, artistPath, singlesPath, searchNameOf(artistPath, artist));
          stat.songs += res.added;
          if (!res.anyError) cache[key] = Date.now();
        }
      }

      if (env.NO_COVERS !== '1') {
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

      // ۲-ب) کاور آهنگ
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
      }
      fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
      console.log(`Done: ${stat.songs} open songs, ${stat.photos} artist photos, ${stat.covers} covers downloaded, ${stat.missed} images not found.`);
    }
  }

  // ۳. خواندن آهنگ‌ها و ساخت فایل JSON
  const result = { artists: [] };
  artistDirs().forEach(dir => {
    const artistName = dir.name;
    const artistPath = path.join(musicDir, artistName);
    const singlesPath = path.join(artistPath, 'singles');
    const artistObj = { name: artistName, photo: null, description: 'ARTIST', singles: [], albums: [] };

    const photo = findLocalPhoto(artistPath, artistName);
    if (photo) artistObj.photo = `music/${artistName}/${photo}`;

    if (fs.existsSync(singlesPath)) {
      const all = fs.readdirSync(singlesPath);
      all.filter(f => f.toLowerCase().endsWith('.mp3')).forEach(file => {
        const base = path.parse(file).name;
        const coverFile = all.find(f => new RegExp(`^${escapeRe(base)}\\.(${IMG_EXT.join('|')})$`, 'i').test(f));
        let lic = null;
        try { lic = JSON.parse(fs.readFileSync(path.join(singlesPath, base + '.license.json'), 'utf8')); } catch {}
        artistObj.singles.push({
          title: titleOf(base),
          artist: artistName,
          audio: `music/${artistName}/singles/${file}`,
          cover: coverFile ? `music/${artistName}/singles/${coverFile}` : null,
          ...(lic ? { license: lic } : {})
        });
      });
    }
    if (artistObj.singles.length > 0 || artistObj.albums.length > 0) result.artists.push(artistObj);
  });

  fs.writeFileSync(path.join(assetsDir, 'library.auto.json'), JSON.stringify(result, null, 2));
  console.log('Successfully generated library.auto.json with ' + result.artists.length + ' artists.');
}

main().catch(e => { console.error(e); process.exit(1); });
