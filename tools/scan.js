const fs = require('fs');
const path = require('path');

const assetsDir = path.join(__dirname, '..', 'assets');
const musicDir = path.join(assetsDir, 'music');
const libFile = path.join(assetsDir, 'library.json');
const cacheFile = path.join(assetsDir, '.cover-cache.json');

const IMG_EXT = ['jpg', 'jpeg', 'png', 'webp'];
const RETRY_MS = 30 * 24 * 3600 * 1000;      // برای آهنگی که کاورش پیدا نشد، ۳۰ روز بعد دوباره امتحان می‌کنه
const DELAY_MS = 3200;                        // iTunes حدود ۲۰ درخواست در دقیقه اجازه می‌ده
const sleep = ms => new Promise(r => setTimeout(r, ms));
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ---------- کمکی‌های پیدا کردن کاور ---------- */
const norm = s => String(s || '').normalize('NFKD')
  .replace(/[\u0300-\u036f\u064b-\u065f\u200c]/g, '')
  .toLowerCase()
  .replace(/\(.*?\)|\[.*?\]/g, ' ')           // (Remix) و [Prod. X] رو برای مقایسه نادیده می‌گیره
  .replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ').trim();

const similar = (a, b) => {
  a = norm(a); b = norm(b);
  return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
};

async function getJson(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// هر منبع یه لیست {artist, title, art} برمی‌گردونه
const providers = [
  async (artist, title) => {
    const j = await getJson('https://itunes.apple.com/search?media=music&entity=song&limit=10&term=' +
      encodeURIComponent(artist + ' ' + title));
    return (j && j.results || []).map(x => ({
      artist: x.artistName, title: x.trackName,
      art: x.artworkUrl100 && x.artworkUrl100.replace(/\d+x\d+bb/, '1000x1000bb')
    }));
  },
  async (artist, title) => {
    const j = await getJson('https://api.deezer.com/search?limit=10&q=' +
      encodeURIComponent(`artist:"${artist}" track:"${title}"`));
    return (j && j.data || []).map(x => ({
      artist: x.artist && x.artist.name, title: x.title,
      art: x.album && (x.album.cover_xl || x.album.cover_big)
    }));
  }
];

async function findCoverUrl(artist, title) {
  for (const p of providers) {
    const list = await p(artist, title);
    // فقط وقتی اسم خواننده و آهنگ هر دو بخونن قبول می‌کنه، تا کاور اشتباه نیاد
    const hit = list.find(c => c.art && similar(c.artist, artist) && similar(c.title, title));
    if (hit) return hit.art;
    await sleep(500);
  }
  return null;
}

async function download(url, dest) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) return false;
    fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
    return true;
  } catch { return false; }
}

const hasCover = (dir, base) =>
  fs.readdirSync(dir).some(f => new RegExp(`^${escapeRe(base)}\\.(${IMG_EXT.join('|')})$`, 'i').test(f));

const titleOf = base => base.includes(' - ') ? base.split(' - ').slice(1).join(' - ') : base;

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

  // ۲. پیدا کردن کاور آهنگ‌هایی که کاور ندارن
  if (process.env.NO_COVERS !== '1' && fs.existsSync(musicDir)) {
    let cache = {};
    try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
    let found = 0, missed = 0;

    for (const dir of fs.readdirSync(musicDir, { withFileTypes: true }).filter(d => d.isDirectory())) {
      const artist = dir.name;
      const singlesPath = path.join(musicDir, artist, 'singles');
      if (!fs.existsSync(singlesPath)) continue;

      for (const file of fs.readdirSync(singlesPath).filter(f => f.toLowerCase().endsWith('.mp3'))) {
        const base = path.parse(file).name;
        if (hasCover(singlesPath, base)) continue;                     // کاور داره، دست نمی‌زنیم
        const key = `${artist}/${base}`;
        if (cache[key] && Date.now() - cache[key] < RETRY_MS) continue; // به‌تازگی پیدا نشده بود

        console.log(`Looking for cover: ${artist} - ${titleOf(base)}`);
        const art = await findCoverUrl(artist, titleOf(base));
        if (art && await download(art, path.join(singlesPath, base + '.jpg'))) {
          found++; delete cache[key];
        } else {
          missed++; cache[key] = Date.now();
        }
        await sleep(DELAY_MS);
      }
    }
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
    console.log(`Covers: ${found} downloaded, ${missed} not found.`);
  }

  // ۳. خواندن آهنگ‌ها و ساخت فایل JSON
  const result = { artists: [] };
  if (fs.existsSync(musicDir)) {
    fs.readdirSync(musicDir, { withFileTypes: true }).filter(d => d.isDirectory()).forEach(dir => {
      const artistName = dir.name;
      const artistPath = path.join(musicDir, artistName);
      const singlesPath = path.join(artistPath, 'singles');
      const artistObj = { name: artistName, photo: null, description: 'ARTIST', singles: [], albums: [] };

      const photo = fs.readdirSync(artistPath).find(f => /^photo\.(jpg|jpeg|png|webp)$/i.test(f));
      if (photo) artistObj.photo = `music/${artistName}/${photo}`;

      if (fs.existsSync(singlesPath)) {
        const all = fs.readdirSync(singlesPath);
        all.filter(f => f.toLowerCase().endsWith('.mp3')).forEach(file => {
          const base = path.parse(file).name;
          const coverFile = all.find(f => new RegExp(`^${escapeRe(base)}\\.(${IMG_EXT.join('|')})$`, 'i').test(f));
          artistObj.singles.push({
            title: titleOf(base),
            artist: artistName,
            audio: `music/${artistName}/singles/${file}`,
            cover: coverFile ? `music/${artistName}/singles/${coverFile}` : null
          });
        });
      }
      if (artistObj.singles.length > 0 || artistObj.albums.length > 0) result.artists.push(artistObj);
    });
  }

  fs.writeFileSync(path.join(assetsDir, 'library.auto.json'), JSON.stringify(result, null, 2));
  console.log('Successfully generated library.auto.json with ' + result.artists.length + ' artists.');
}

main().catch(e => { console.error(e); process.exit(1); });
