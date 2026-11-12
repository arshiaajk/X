// Scans assets/music/ and writes assets/library.auto.json  (no dependencies)
// ... (توضیحات بالای فایل شما بدون تغییر می‌ماند) ...

const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..", "assets"), MUSIC = path.join(ROOT, "music");
const AUD = /\.(mp3|m4a|ogg|wav|flac)$/i, IMG = /\.(jpe?g|png|webp)$/i;
const rel = p => path.relative(ROOT, p).split(path.sep).join("/");
const ls = d => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : [];
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true });

// مدیریت خطا برای خواندن فایل‌های JSON (اگر فایل خراب باشد، اسکریپت متوقف نمی‌شود)
const read = f => {
  if (!fs.existsSync(f)) return {};
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (e) {
    console.warn(`⚠️ Warning: Could not parse JSON in ${f}`);
    return {};
  }
};

const findImg = (dir, base) => {
  const f = ls(dir).map(e => e.name).find(n => IMG.test(n) && path.parse(n).name.toLowerCase() === base.toLowerCase());
  return f ? rel(path.join(dir, f)) : null;
};

// ---------- Extract embedded cover (APIC) from MP3 ----------
function extractCoverFromMp3(audioPath, outPath) {
  try {
    if (fs.existsSync(outPath)) return true;
    const buf = fs.readFileSync(audioPath);
    if (buf.length < 10 || buf.toString("ascii", 0, 3) !== "ID3") return false;
    const ver = buf[3];
    const flags = buf[5];
    let size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    let offset = 10;
    if (flags & 0x40) {
      const extSize = (buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3];
      offset += 4 + extSize;
    }
    const end = Math.min(offset + size, buf.length);
    while (offset + 10 < end) {
      const id = buf.toString("ascii", offset, offset + 4);
      let frameSize;
      if (ver === 4) {
        frameSize = ((buf[offset + 4] & 0x7f) << 21) | ((buf[offset + 5] & 0x7f) << 14) | ((buf[offset + 6] & 0x7f) << 7) | (buf[offset + 7] & 0x7f);
      } else {
        frameSize = (buf[offset + 4] << 24) | (buf[offset + 5] << 16) | (buf[offset + 6] << 8) | buf[offset + 7];
      }
      if (frameSize <= 0 || offset + 10 + frameSize > buf.length) break;

      if (id === "APIC" || id === "PIC") {
        let pos = offset + 10;
        const encoding = buf[pos++];
        while (pos < offset + 10 + frameSize && buf[pos] !== 0) pos++;
        pos++;
        if (id === "APIC") {
          pos++;
          if (encoding === 1 || encoding === 2) {
            while (pos + 1 < offset + 10 + frameSize && !(buf[pos] === 0 && buf[pos + 1] === 0)) pos += 2;
            pos += 2;
          } else {
            while (pos < offset + 10 + frameSize && buf[pos] !== 0) pos++;
            pos++;
          }
        } else {
          pos += 3; pos++;
          while (pos < offset + 10 + frameSize && buf[pos] !== 0) pos++;
          pos++;
        }
        const imgData = buf.slice(pos, offset + 10 + frameSize);
        if (imgData.length > 100) {
          fs.writeFileSync(outPath, imgData);
          return true;
        }
      }
      offset += 10 + frameSize;
    }
  } catch (e) { /* ignore */ }
  return false;
}

function getCover(dir, baseName, audioFile) {
  let cover = findImg(dir, baseName);
  if (cover) return cover;
  if (/\.mp3$/i.test(audioFile)) {
    const outName = baseName + ".jpg";
    const outPath = path.join(dir, outName);
    if (extractCoverFromMp3(path.join(dir, audioFile), outPath)) {
      return rel(outPath);
    }
  }
  return null;
}

const norm = s => s.toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g, "");
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const JUNK = /\b(bandmusic|band music|mahan ?music|aria ?music|radio ?javan|download|official|audio|lyrics?|music video|video|hd|hq|\d{2,3} ?kbps|128|192|256|320|www)\b/i;

function parseName(file, artist, numbered, album) {
  let s = file.replace(AUD, "").replace(/_+/g, " ");
  s = s.replace(/[\s\-–_]*\b(?:www\.)?[a-z0-9]+\.(?:com|net|ir|org|info|me|ws|biz|co)\b/gi, "");
  s = s.replace(/[\(\[][^\)\]]*[\)\]]/g, m => JUNK.test(m) ? "" : m);
  s = s.replace(/[\s\-–]*\b(?:128|192|256|320)\s*(?:kbps)?\s*$/i, "").replace(/\s+/g, " ").trim();
  const num = numbered ? /^\d{1,3}(?:\s*[-–)]\s*|\.(?=\D)\s*|\s+)/ : /^0\d{1,2}(?:\s*[-–)]\s*|\.(?=\D)\s*|\s+)/;
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
  if (!/\s/.test(s) && s === s.toLowerCase()) s = s.split(/[-_]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  s = s.replace(/\s+/g, " ").replace(/^[-–\s]+|[-–\s]+$/g, "") || file.replace(AUD, "");
  const f = [...new Set(feat.join(", ").replace(/\s+x\s+/gi, ", ").split(/\s*,\s*|\s*&\s*/).map(x => x.trim()).filter(x => x && norm(x) !== na))];
  return { title: s, artist: f.length ? artist + " feat. " + f.join(", ") : artist };
}

function main() {
  try {
    // اطمینان از وجود پوشه assets برای جلوگیری از خطای ENOENT هنگام ذخیره فایل
    if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT, { recursive: true });
    if (!fs.existsSync(MUSIC)) fs.mkdirSync(MUSIC, { recursive: true });

    const artists = [];
    let missingPhotos = [];

    for (const d of ls(MUSIC).filter(e => e.isDirectory()).sort((a, b) => natural(a.name, b.name))) {
      const dir = path.join(MUSIC, d.name), meta = read(path.join(dir, "artist.json"));
      const name = meta.name || d.name;

      const photo = findImg(dir, "photo");
      if (!photo) missingPhotos.push(name);

      const singles = ls(path.join(dir, "singles")).map(e => e.name).filter(n => AUD.test(n)).sort(natural).map(n => {
        const p = parseName(n, name, false);
        const base = path.parse(n).name;
        return { title: p.title, artist: p.artist, cover: getCover(path.join(dir, "singles"), base, n), audio: rel(path.join(dir, "singles", n)) };
      });

      const albums = ls(path.join(dir, "albums")).filter(e => e.isDirectory()).sort((a, b) => natural(a.name, b.name)).map(a => {
        const ad = path.join(dir, "albums", a.name), tm = read(path.join(ad, "tracks.json"));
        let albumCover = findImg(ad, "cover");
        const tracks = ls(ad).map(e => e.name).filter(n => AUD.test(n)).sort(natural).map(n => {
          const p = parseName(n, name, true, a.name);
          const base = path.parse(n).name;
          const trackCover = getCover(ad, base, n);
          if (!albumCover && trackCover) albumCover = trackCover;
          return { title: (tm[n] && tm[n].title) || p.title, artist: (tm[n] && tm[n].artist) || p.artist, audio: rel(path.join(ad, n)) };
        });
        return { title: a.name, cover: albumCover, tracks };
      });

      artists.push({ name, photo, description: meta.description || "ARTIST", aliases: meta.aliases || [], singles, albums });
    }

    fs.writeFileSync(path.join(ROOT, "library.auto.json"), JSON.stringify({ artists }, null, 1));
    console.log("library.auto.json:", artists.length, "artists");

    if (missingPhotos.length) {
      console.log("\n⚠️ عکس خواننده پیدا نشد برای این هنرمندها:");
      missingPhotos.forEach(n => console.log("   • " + n));
    } else {
      console.log("✓ همه هنرمندها عکس دارند.");
    }
  } catch (err) {
    console.error("❌ Fatal error during scan:", err);
    process.exit(1); // خروج با کد خطا برای اینکه گیت‌هاب متوجه مشکل شود
  }
}

if (require.main === module) main();
module.exports = { parseName, extractCoverFromMp3 };
