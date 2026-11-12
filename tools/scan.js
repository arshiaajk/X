const fs = require('fs');
const path = require('path');

const assetsDir = path.join(__dirname, '..', 'assets');
const musicDir = path.join(assetsDir, 'music');
const libFile = path.join(assetsDir, 'library.json');

// ۱. ساخت پوشه‌ها
if (!fs.existsSync(musicDir)) fs.mkdirSync(musicDir, { recursive: true });

if (fs.existsSync(libFile)) {
  try {
    const lib = JSON.parse(fs.readFileSync(libFile, 'utf8'));
    const artists = lib.artists || [];
    artists.forEach(a => {
      if (a.name) {
        const s = path.join(musicDir, a.name, 'singles');
        const alb = path.join(musicDir, a.name, 'albums');
        if (!fs.existsSync(s)) fs.mkdirSync(s, { recursive: true });
        if (!fs.existsSync(alb)) fs.mkdirSync(alb, { recursive: true });
        if (!fs.existsSync(path.join(s, '.gitkeep'))) fs.writeFileSync(path.join(s, '.gitkeep'), '');
        if (!fs.existsSync(path.join(alb, '.gitkeep'))) fs.writeFileSync(path.join(alb, '.gitkeep'), '');
      }
    });
    console.log("Folders created successfully.");
  } catch (e) { console.log('Error reading library.json'); }
}

// ۲. خواندن آهنگ‌ها و ساخت فایل JSON
const result = { artists: [] };
if (fs.existsSync(musicDir)) {
  const artistDirs = fs.readdirSync(musicDir, { withFileTypes: true }).filter(d => d.isDirectory());

  artistDirs.forEach(dir => {
    const artistName = dir.name;
    const artistPath = path.join(musicDir, artistName);
    const singlesPath = path.join(artistPath, 'singles');
    
    const artistObj = { name: artistName, photo: null, description: "ARTIST", singles: [], albums: [] };

    // عکس خواننده
    if (fs.existsSync(artistPath)) {
      const files = fs.readdirSync(artistPath);
      const photo = files.find(f => f.match(/^photo\.(jpg|jpeg|png|webp)$/i));
      if (photo) artistObj.photo = `music/${artistName}/${photo}`;
    }

    // آهنگ‌ها
    if (fs.existsSync(singlesPath)) {
      const files = fs.readdirSync(singlesPath).filter(f => f.endsWith('.mp3'));
      files.forEach(file => {
        const baseName = path.parse(file).name;
        let title = baseName.includes(' - ') ? baseName.split(' - ').slice(1).join(' - ') : baseName;
        const coverFile = fs.readdirSync(singlesPath).find(f => f.match(new RegExp(`^${baseName}\\.(jpg|jpeg|png|webp)$`, 'i')));
        
        artistObj.singles.push({
          title: title,
          artist: artistName,
          audio: `music/${artistName}/singles/${file}`,
          cover: coverFile ? `music/${artistName}/singles/${coverFile}` : null
        });
      });
    }

    if (artistObj.singles.length > 0 || artistObj.albums.length > 0) {
      result.artists.push(artistObj);
    }
  });
}

fs.writeFileSync(path.join(assetsDir, 'library.auto.json'), JSON.stringify(result, null, 2));
console.log('Successfully generated library.auto.json with ' + result.artists.length + ' artists.');
