// Kolory (paleta) i tekstury (biblioteka obrazów) – wspólne dla edytora mebli i mieszkania.
// Biblioteka siedzi w pamięci przeglądarki (localStorage), obrazy są zmniejszane do 512 px.
import * as THREE from 'three';

export interface Swatch { name: string; hex: string }

export const PALETTE: Swatch[] = [
  { name: 'Biały', hex: '#f4f4f2' }, { name: 'Kremowy', hex: '#eadfc8' }, { name: 'Jasnoszary', hex: '#c9ccd0' },
  { name: 'Szary', hex: '#8d9196' }, { name: 'Grafit', hex: '#3d4147' }, { name: 'Czarny', hex: '#1c1c1e' },
  { name: 'Dąb jasny', hex: '#d6b98c' }, { name: 'Dąb sonoma', hex: '#c8a574' }, { name: 'Dąb ciemny', hex: '#8a6a45' },
  { name: 'Orzech', hex: '#5e4330' }, { name: 'Buk', hex: '#d9a86c' }, { name: 'Wenge', hex: '#3a2c25' },
  { name: 'Beż', hex: '#cbb89a' }, { name: 'Czerwony', hex: '#b3261e' }, { name: 'Bordo', hex: '#6d1f2c' },
  { name: 'Pomarańczowy', hex: '#e07b24' }, { name: 'Żółty', hex: '#e8c33a' }, { name: 'Zielony', hex: '#4f8a5b' },
  { name: 'Oliwkowy', hex: '#7d8450' }, { name: 'Turkusowy', hex: '#2f8f9d' }, { name: 'Niebieski', hex: '#2f5fa7' },
  { name: 'Granatowy', hex: '#1f2f55' }, { name: 'Różowy', hex: '#d98ca6' }, { name: 'Fioletowy', hex: '#6a4c93' },
];

const TEX_KEY = 'meblarz:textures';
const PAL_KEY = 'meblarz:palette';

// ---------- własne kolory ----------
export function readCustomPalette(): Swatch[] {
  try { return JSON.parse(localStorage.getItem(PAL_KEY) ?? '[]'); } catch { return []; }
}
export function addCustomColor(name: string, hex: string) {
  const list = readCustomPalette().filter((c) => c.hex.toLowerCase() !== hex.toLowerCase());
  list.push({ name, hex: hex.toLowerCase() });
  localStorage.setItem(PAL_KEY, JSON.stringify(list));
}
export function removeCustomColor(hex: string) {
  localStorage.setItem(PAL_KEY, JSON.stringify(readCustomPalette().filter((c) => c.hex.toLowerCase() !== hex.toLowerCase())));
}
/** Nazwa koloru z palety (albo sam kod, gdy koloru nie ma w palecie). */
export function colorName(hex: string): string {
  const h = hex.toLowerCase();
  return [...PALETTE, ...readCustomPalette()].find((c) => c.hex.toLowerCase() === h)?.name ?? hex;
}

// ---------- tekstury ----------
let lib: Record<string, string> | null = null; // nazwa -> data URL (JPEG)
const cache = new Map<string, THREE.Texture>();

function readLib(): Record<string, string> {
  if (!lib) {
    try { lib = JSON.parse(localStorage.getItem(TEX_KEY) ?? '{}'); } catch { lib = {}; }
  }
  return lib!;
}
export const textureNames = () => Object.keys(readLib()).sort((a, b) => a.localeCompare(b));

/** Tekstura z biblioteki albo null, gdy takiej nazwy nie ma. Obraz doładowuje się sam. */
export function getTexture(name: string): THREE.Texture | null {
  const c = cache.get(name);
  if (c) return c;
  const url = readLib()[name];
  if (!url) return null;
  const t = new THREE.TextureLoader().load(url);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  cache.set(name, t);
  return t;
}

/** false, gdy zabrakło miejsca w pamięci przeglądarki. */
export function addTexture(name: string, dataUrl: string): boolean {
  const l = readLib();
  const old = l[name];
  l[name] = dataUrl;
  try {
    localStorage.setItem(TEX_KEY, JSON.stringify(l));
  } catch {
    if (old === undefined) delete l[name]; else l[name] = old;
    return false;
  }
  cache.get(name)?.dispose();
  cache.delete(name);
  return true;
}
export function removeTexture(name: string) {
  const l = readLib();
  delete l[name];
  localStorage.setItem(TEX_KEY, JSON.stringify(l));
  cache.get(name)?.dispose();
  cache.delete(name);
}

/** Wczytuje obraz, przycina do kwadratu (środek) i zmniejsza do maxPx. */
export function imageToDataUrl(file: File, maxPx = 512): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const side = Math.min(img.width, img.height);
      const out = Math.min(maxPx, side);
      const c = document.createElement('canvas');
      c.width = c.height = out;
      const g = c.getContext('2d')!;
      g.fillStyle = '#fff';
      g.fillRect(0, 0, out, out);
      g.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, out, out);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.88));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Nie udało się wczytać tego obrazu.')); };
    img.src = url;
  });
}

/**
 * Prostopadłościan o wymiarach `size` (mm) z UV liczonymi w mm: jedno powtórzenie tekstury = `tile` mm.
 * Usłojenie (oś u) biegnie wzdłuż dłuższego wymiaru ścianki; `rot` obraca je o 90°.
 */
export function boxGeometry(size: [number, number, number], tile: number, rot: boolean): THREE.BoxGeometry {
  const g = new THREE.BoxGeometry(size[0], size[1], size[2]);
  const pos = g.getAttribute('position');
  const uv = g.getAttribute('uv');
  const t = Math.max(10, tile);
  for (let i = 0; i < pos.count; i++) {
    const n = Math.floor(i / 4) >> 1; // kolejność ścianek: +x, -x, +y, -y, +z, -z
    const [a, b] = n === 0 ? [1, 2] : n === 1 ? [0, 2] : [0, 1];
    let [ua, vb] = size[a] >= size[b] ? [a, b] : [b, a];
    if (rot) [ua, vb] = [vb, ua];
    const c = [pos.getX(i) + size[0] / 2, pos.getY(i) + size[1] / 2, pos.getZ(i) + size[2] / 2];
    uv.setXY(i, c[ua] / t, c[vb] / t);
  }
  uv.needsUpdate = true;
  return g;
}

// ---------- pliki z osadzonymi teksturami ----------
// Plik mebla: {"format":"meblarz-furniture","version":2,"panels":[...],"textures":{nazwa: data URL}}.
// Starsze pliki (sama tablica płyt) nadal się wczytują.

export const getTextureData = (name: string): string | undefined => readLib()[name];

/** Nazwy tekstur użytych przez płyty. */
export const usedTextures = (panels: { texture?: string }[]): string[] =>
  [...new Set(panels.map((p) => p.texture).filter((t): t is string => !!t))];

/** Zamienia JSON płyt na plik mebla z wbudowanymi użytymi teksturami. */
export function packFurniture(panelsJson: string): string {
  const panels = JSON.parse(panelsJson);
  const textures: Record<string, string> = {};
  for (const n of usedTextures(panels)) {
    const d = getTextureData(n);
    if (d) textures[n] = d;
  }
  return JSON.stringify({ format: 'meblarz-furniture', version: 2, panels, textures });
}

/** Odczytuje plik mebla (nowy lub stary format). */
export function unpackFurniture(text: string): { panelsJson: string; textures: Record<string, string> } {
  const v = JSON.parse(text);
  if (Array.isArray(v)) return { panelsJson: text, textures: {} };
  if (v && Array.isArray(v.panels)) return { panelsJson: JSON.stringify(v.panels), textures: v.textures ?? {} };
  throw new Error('Nieprawidłowy plik mebla');
}

/**
 * Dodaje wbudowane tekstury do biblioteki. Gdy nazwa jest już zajęta przez INNY obraz, nowa tekstura
 * dostaje nazwę "nazwa (2)" itd. – `renames` mówi, co zmieniono (stara nazwa -> nowa).
 */
export function importTextures(textures: Record<string, string>) {
  const l = readLib();
  const renames: Record<string, string> = {};
  const failed: string[] = [];
  for (const [name, data] of Object.entries(textures)) {
    let target = name;
    for (let i = 2; l[target] !== undefined && l[target] !== data; i++) target = `${name} (${i})`;
    if (target !== name) renames[name] = target;
    if (l[target] === data) continue; // ta sama tekstura już jest w bibliotece
    if (!addTexture(target, data)) failed.push(name);
  }
  return { renames, failed };
}

/** Podmienia nazwy tekstur w JSON-ie płyt zgodnie z `renames`. */
export function applyRenames(panelsJson: string, renames: Record<string, string>): string {
  if (!Object.keys(renames).length) return panelsJson;
  const panels = JSON.parse(panelsJson);
  for (const p of panels) if (p.texture && renames[p.texture]) p.texture = renames[p.texture];
  return JSON.stringify(panels);
}
