// Flat master music library with genre codes.
window.musicLibraryGenreMap = {
  "9": "90s Alternative",
  "A": "Alternative",
  "M": "Animated Music",
  "+": "Indie Kaleidoscope",
  "R": "Rock",
  "P": "Pop",
  "U": "Punk",
  "H": "Hip-HopandRap",
  "E": "ElectronicandDance",
  "B": "RandBandSoul",
  "C": "Country",
  "F": "Folk"
};

window.musicLibrary = [
];

// Optional alias for compatibility.
var musicLibrary = window.musicLibrary;
window.musicLibraryFlat = Array.isArray(window.musicLibrary) ? window.musicLibrary.slice() : [];

window.musicLibraryParseEntry = function(entry) {
  const raw = String(entry == null ? '' : entry).trim();
  const idx = raw.lastIndexOf('$');
  const base = idx === -1 ? raw : raw.slice(0, idx).trim();
  const code = idx === -1 ? '' : raw.slice(idx + 1).trim();
  return { base, codes: code ? [code] : [] };
};

window.musicLibraryNormalizeBase = function(raw) {
  let s = String(raw == null ? '' : raw).trim();
  try { s = decodeURIComponent(s); } catch (e) {}
  s = s.split(/[\\/]/).pop();
  s = s.replace(/\.(mp3|flac|wav|m4a|ogg|aac|opus|wma|alac|mp4|m4v|mov|webm|mkv)(\?.*)?$/i, '');
  s = s.replace(/(?:\$[A-Za-z0-9+]+)+$/g, '');
  return s.trim();
};