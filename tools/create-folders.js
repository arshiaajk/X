const fs = require("fs");
const path = require("path");

const LIB_PATH = path.join(__dirname, "..", "assets", "library.json");
const MUSIC_DIR = path.join(__dirname, "..", "assets", "music");

function createFolders() {
  try {
    // 1. اطمینان از وجود مسیرها
    if (!fs.existsSync(MUSIC_DIR)) {
      fs.mkdirSync(MUSIC_DIR, { recursive: true });
    }

    if (!fs.existsSync(LIB_PATH)) {
      console.log("⚠️ assets/library.json not found. Skipping folder creation.");
      return;
    }

    // 2. خواندن فایل و مدیریت خطای فرمت JSON
    let data;
    try {
      data = JSON.parse(fs.readFileSync(LIB_PATH, "utf8"));
    } catch (parseError) {
      console.log("⚠️ library.json has invalid format. Please check it.");
      return;
    }

    const artists = Array.isArray(data) ? data : (data.artists || []);

    // 3. ساخت پوشه‌ها با ایمنی بالا
    artists.forEach((artist, index) => {
      if (!artist || !artist.name) return;
      
      // تمیز کردن اسم پوشه از کاراکترهای غیرمجاز (مثل / و ?)
      const safeName = artist.name.replace(/[/\\?%*:|"<>]/g, '-').trim();
      if (!safeName) return;

      const artistDir = path.join(MUSIC_DIR, safeName);
      const singlesDir = path.join(artistDir, "singles");
      const albumsDir = path.join(artistDir, "albums");

      try {
        [singlesDir, albumsDir].forEach(dir => {
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
        });

        // ساخت فایل مخفی برای اینکه گیت پوشه‌های خالی را پاک نکند
        const keepSingles = path.join(singlesDir, ".gitkeep");
        const keepAlbums = path.join(albumsDir, ".gitkeep");
        
        if (!fs.existsSync(keepSingles)) fs.writeFileSync(keepSingles, "");
        if (!fs.existsSync(keepAlbums)) fs.writeFileSync(keepAlbums, "");

        console.log(`✅ Checked/Created folders for: ${artist.name}`);
      } catch (fsError) {
        console.log(`⚠️ Could not create folders for ${artist.name}:`, fsError.message);
      }
    });
  } catch (globalError) {
    console.error("❌ Error in create-folders script:", globalError);
  }
}

createFolders();
