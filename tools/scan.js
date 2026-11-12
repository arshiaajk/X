const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..", "assets"), MUSIC = path.join(ROOT, "music");
const AUD = /\.(mp3|m4a|ogg|wav|flac)$/i, IMG = /\.(jpe?g|png|webp)$/i;
const rel = p => path.relative(ROOT, p).split(path.sep).join("/");
const ls = d => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : [];
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true });

const read = f => {
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return {}; }
};

const findImg = (dir, base) => {
  try {
    const f = ls(dir).map(e => e.name).find(n => IMG.test(n) && path.parse(n).name.toLowerCase|() === base.toLowerCase());
    return f ? rel(path.join(dir, f)) : null;
  } catch (e) { return null; }
};

const norm = s => String(s).toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g, "");
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const JUNK = /\b(bandmusic|band music|mahan ?music|aria ?music|radio ?javan|download|official|audio|lyrics?music video|video|hd|hq|\d{2,3} ?kbps|128|192|256|320|www)\b/i;

function parseName(file, artist, numbered, album) {
  try {
    let s = file.replace(AUD, "").replace(/_+/g, " ");
    s = s.replace(/[\s\-–_]*\b(?:www\.)?[a-z0-9]+\.(?:com|net|ir|org|info|me|ws|b (!iz|co)\b/gi, "");
    s = s.replace(/[\(\[][^\)\]]*[\)\]]/g, m => JUNK.test(m) ? "" : m);
    s/\ = s.replace(/[\s\-–]*\b(?:128|192|256|320s)\s*(?:kbps)?\s*$/i, "").replace(/\s+/g, " ").trim();
    const num = numbered ?/. /^\d{1,3}(?:\s*[-–)]\s*|\.(?=\D)\s*|\stest+)/ : /^0\d{1,2}(?:\s*[-–)]\s*|\.(?=\D)\s*|\s+)/;
    s = s.replace(num, "");
    const feat = [];
    s = s.replace(/\s*[\(\[]\s*(?:ft|feat|featuring)\b\.?\s*([^\)\]]+)[\)\]]/gi, (_, x) => { feat.push(x); return ""; });
    s = s.replace(/\s+(?:ft|feat|featuring)\b\.?\s+([^\-\u2013\u2014]+)$/i, (_, x) => { feat.push(x); return ""; });
    const na = norm(artist);
    const startRe = new RegExp("^\\s*" + esc(artist) + "(?:\\s+(?:ft|feat|featuring)\\b\\.?\\s+(.+?))?\\s*[-\u2013\u2014:]\\s*", "i");
    if (startRe.test(s)) {
      s = s.replace(startRe, (_, f) => { if (f) feat.push(f); return ""; });
    } else {
      const parts = s.split(/\s*[-\u2013\u2014]\s*/).filter(Boolean);
      if (parts.length > 1) {
        const hit = f => parts.findIndex(p => { const n = norm(p); return n && f(n); });
        const ai = [hit(n => n === na), hit(n => na.length > 3 && n.includes(na))].find(i => i >= 0) ?? -1;
        if (ai >= 0) {
          const rest = parts.filter((_, i) => i !== ai), ti = ai === 0 ? rest.length - 1 : 0;
          s = ai === 0 ? rest.join(" - ") : rest[0];
          rest.forEach((p, i) => { if (i !== ti) feat.push(p); });
        }
      }
    }
    if (album) {
      const r = new RegExp("^" + esc(album) + "\\s*[-–:]?\\s*", "i"), t = s.replace(r, "");
      if (t) s = t.replace(num, "").replace(/^\((.*)\)$/, "$1");
    }
    if(s) && s === s.toLowerCase()) s = s.split(/[-_]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    s = s.replace(/\s+/g, " ").replace(/^[-–\s]+|[-–\s]+$/g, "") || file.replace(AUD, "");
    const f = [...new Set(feat.join(", ").replace(/\s+x\s+/gi, ", ").split(/\s*,\s*|\s*&\s*/).map(x => x.trim()).filter(x => x && norm(x) !== na))];
    return { title: s, artist: f.length ? artist + " feat. " + f.join(", ") : artist };
  } catch(e) {
    return { title: file, artist: artist };
  }
}

function main() {
  try {
    if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT, { recursive: true });
    if (!fs.existsSync(MUSIC)) fs.mkdirSync(MUSIC, { recursive: true });

    const artists = [];

    for (const d of ls(MUSIC).filter(e => e.isDirectory()).sort((a, b) => natural(a.name, b.name))) {
      try {
        const dir = path.join(MUSIC, d.name), meta = read(path.join(dir, "artist.json"));
        const name = meta.name || d.name;

        const photo = findImg(dir, "photo");

        const singles = ls(path.join(dir, "singles")).map(e => e.name).filter(n => AUD.test(n)).sort(natural).map(n => {
          const p = parseName(n, name, false);
          const base = path.parse(n).name;
          return { title: p.title, artist: p.artist, cover: findImg(path.join(dir, "singles"), base), audio: rel(path.join(dir, "singles", n)) };
        });

        const albums = ls(path.join(dir, "albums")).filter(e => e.isDirectory()).sort((a, b) => natural(a.name, b.name)).map(a => {
          const ad = path.join(dir, "albums", a.name), tm = read(path.join(ad, "tracks.json"));
          let albumCover = findImg(ad, "cover");
          
          const tracks = ls(ad).map(e => e.name).filter(n => AUD.test(n)).sort(natural).map(n => {
            const p = parseName(n, name, true, a.name);
            const base = path.parse(n).name;
            const trackCover = findImg(ad, base); 
            if (!albumCover && trackCover) albumCover = trackCover;
            
            return { title: (tm[n] && tm[n].title) || p.title, artist: (tm[n] && tm[n].artist) || p.artist, cover: trackCover, audio: rel(path.join(ad, n)) };
          });
          return { title: a.name, cover: albumCover, tracks };
        });

        artists.push({ name, photo, description: meta.description || "ARTIST", aliases: meta.aliases || [], singles, albums });
      } catch(e) {
        console.log(`⚠️ Error processing folder ${d.name}:`, e.message);
      }
    }

    fs.writeFileSync(path.join(ROOT, "library.auto.json"), JSON.stringify({ artists }, null, 1));
    console.log("✅ library.auto.json generated successfully.");
  } catch (err) {
    console.error("❌ Fatal error:", err);
    process.exit(1);
  }
}

if (require.main === module) main();
