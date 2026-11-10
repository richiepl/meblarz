// Obsługa plików AutoCAD w formacie DXF (tekstowym). DWG jest formatem zamkniętym – patrz README.

/** Odcinek: x1, y1, x2, y2, czy pochodzi z krzywej (łuk/okrąg/łuk polilinii: 1). */
export type Seg = [number, number, number, number, number];

export interface DxfData {
  layers: Map<string, Seg[]>;
  unitScale: number; // mnożnik jednostek rysunku na mm (z nagłówka; 1 gdy brak)
  unitKnown: boolean;
  skipped: Record<string, number>; // pominięte typy obiektów (tekst, spline...)
}

type Tok = [number, string];
interface Ent { type: string; t: Tok[] }
interface Block { name: string; base: [number, number]; ents: Ent[] }

const get = (e: Ent, code: number): string | undefined => e.t.find((x) => x[0] === code)?.[1];
const getN = (e: Ent, code: number, def = 0): number => {
  const v = get(e, code);
  return v === undefined ? def : parseFloat(v);
};

function splitEntities(tokens: Tok[]): Ent[] {
  const out: Ent[] = [];
  let cur: Ent | null = null;
  for (const tk of tokens) {
    if (tk[0] === 0) { cur = { type: tk[1], t: [] }; out.push(cur); }
    else cur?.t.push(tk);
  }
  return out;
}

/** Łuk od kąta a0 o kąt sweep (rad) jako odcinki. */
function arcSegs(cx: number, cy: number, r: number, a0: number, sweep: number, layer: string, out: { layer: string; seg: Seg }[]) {
  const n = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 18))); // co ok. 10°
  let px = cx + r * Math.cos(a0), py = cy + r * Math.sin(a0);
  for (let i = 1; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
    out.push({ layer, seg: [px, py, x, y, 1] });
    px = x; py = y;
  }
}

/** Krawędź polilinii z "bulge" (wypukłością) jako odcinki. */
function bulgeEdge(x1: number, y1: number, x2: number, y2: number, b: number, layer: string, out: { layer: string; seg: Seg }[]) {
  if (!b) { out.push({ layer, seg: [x1, y1, x2, y2, 0] }); return; }
  const theta = 4 * Math.atan(b); // kąt łuku ze znakiem (+ = przeciwnie do zegara)
  const dx = x2 - x1, dy = y2 - y1;
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-9) return;
  const r = chord / (2 * Math.sin(theta / 2)); // ze znakiem
  const h = r * Math.cos(theta / 2);
  const cx = (x1 + x2) / 2 + (-dy / chord) * h;
  const cy = (y1 + y2) / 2 + (dx / chord) * h;
  arcSegs(cx, cy, Math.abs(r), Math.atan2(y1 - cy, x1 - cx), theta, layer, out);
}

export function parseDxf(text: string): DxfData {
  if (text.startsWith('AutoCAD Binary DXF')) throw new Error('Binarny DXF nie jest obsługiwany – zapisz jako DXF tekstowy (ASCII).');
  const lines = text.split(/\r?\n/);
  const tokens: Tok[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) tokens.push([parseInt(lines[i].trim(), 10), lines[i + 1].trim()]);

  // sekcje
  const sections = new Map<string, Tok[]>();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i][0] === 0 && tokens[i][1] === 'SECTION' && tokens[i + 1]?.[0] === 2) {
      const name = tokens[i + 1][1];
      let j = i + 2;
      while (j < tokens.length && !(tokens[j][0] === 0 && tokens[j][1] === 'ENDSEC')) j++;
      sections.set(name, tokens.slice(i + 2, j));
      i = j;
    }
  }

  // jednostki
  const header = sections.get('HEADER') ?? [];
  const hi = header.findIndex((t) => t[0] === 9 && t[1] === '$INSUNITS');
  const code = hi >= 0 ? parseInt(header[hi + 1]?.[1] ?? '0', 10) : 0;
  const UNITS: Record<number, number> = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 13: 0.001, 14: 100 };
  const unitScale = UNITS[code] ?? 1;

  // bloki
  const blocks = new Map<string, Block>();
  let curBlock: Block | null = null;
  for (const e of splitEntities(sections.get('BLOCKS') ?? [])) {
    if (e.type === 'BLOCK') curBlock = { name: get(e, 2) ?? '', base: [getN(e, 10), getN(e, 20)], ents: [] };
    else if (e.type === 'ENDBLK') { if (curBlock) blocks.set(curBlock.name, curBlock); curBlock = null; }
    else curBlock?.ents.push(e);
  }

  const skipped: Record<string, number> = {};

  function convert(ents: Ent[], parentLayer: string | null, depth: number): { layer: string; seg: Seg }[] {
    const out: { layer: string; seg: Seg }[] = [];
    const layerOf = (e: Ent) => {
      const l = get(e, 8) ?? '0';
      return l === '0' && parentLayer ? parentLayer : l;
    };
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      const layer = layerOf(e);
      switch (e.type) {
        case 'LINE':
          out.push({ layer, seg: [getN(e, 10), getN(e, 20), getN(e, 11), getN(e, 21), 0] });
          break;
        case 'ARC': {
          const a0 = (getN(e, 50) * Math.PI) / 180;
          let a1 = (getN(e, 51) * Math.PI) / 180;
          if (a1 <= a0) a1 += Math.PI * 2;
          arcSegs(getN(e, 10), getN(e, 20), getN(e, 40), a0, a1 - a0, layer, out);
          break;
        }
        case 'CIRCLE':
          arcSegs(getN(e, 10), getN(e, 20), getN(e, 40), 0, Math.PI * 2, layer, out);
          break;
        case 'LWPOLYLINE':
        case 'POLYLINE': {
          let vertexEnts: Ent[] = [e];
          if (e.type === 'POLYLINE') { // stary format: wierzchołki w osobnych obiektach VERTEX
            vertexEnts = [];
            while (i + 1 < ents.length && ents[i + 1].type !== 'SEQEND') { i++; if (ents[i].type === 'VERTEX') vertexEnts.push(ents[i]); }
            i++; // SEQEND
          }
          const vs: { x: number; y: number; b: number }[] = [];
          if (e.type === 'LWPOLYLINE') {
            for (const [c, v] of e.t) {
              if (c === 10) vs.push({ x: parseFloat(v), y: 0, b: 0 });
              else if (c === 20 && vs.length) vs[vs.length - 1].y = parseFloat(v);
              else if (c === 42 && vs.length) vs[vs.length - 1].b = parseFloat(v);
            }
          } else {
            for (const v of vertexEnts) vs.push({ x: getN(v, 10), y: getN(v, 20), b: getN(v, 42) });
          }
          const closed = (getN(e, 70) & 1) === 1;
          const n = closed ? vs.length : vs.length - 1;
          for (let k = 0; k < n; k++) {
            const a = vs[k], b = vs[(k + 1) % vs.length];
            bulgeEdge(a.x, a.y, b.x, b.y, a.b, layer, out);
          }
          break;
        }
        case 'INSERT': {
          const blk = blocks.get(get(e, 2) ?? '');
          if (!blk || depth >= 4) break;
          const sx = getN(e, 41, 1), sy = getN(e, 42, 1);
          const rot = (getN(e, 50) * Math.PI) / 180;
          const [ix, iy] = [getN(e, 10), getN(e, 20)];
          const c = Math.cos(rot), s = Math.sin(rot);
          const tf = (x: number, y: number): [number, number] => {
            const dx = (x - blk.base[0]) * sx, dy = (y - blk.base[1]) * sy;
            return [ix + dx * c - dy * s, iy + dx * s + dy * c];
          };
          for (const it of convert(blk.ents, layer === '0' ? parentLayer : layer, depth + 1)) {
            const [x1, y1] = tf(it.seg[0], it.seg[1]);
            const [x2, y2] = tf(it.seg[2], it.seg[3]);
            out.push({ layer: it.layer, seg: [x1, y1, x2, y2, it.seg[4]] });
          }
          break;
        }
        case 'SEQEND': case 'VERTEX': case 'ENDBLK': break;
        default:
          skipped[e.type] = (skipped[e.type] ?? 0) + 1;
      }
    }
    return out;
  }

  const layers = new Map<string, Seg[]>();
  for (const it of convert(splitEntities(sections.get('ENTITIES') ?? []), null, 0)) {
    if (!it.seg.every(Number.isFinite)) continue;
    if (!layers.has(it.layer)) layers.set(it.layer, []);
    layers.get(it.layer)!.push(it.seg);
  }
  return { layers, unitScale, unitKnown: code !== 0, skipped };
}

// ---------------------------------------------------------------- zapis

export interface DxfLayer {
  name: string; // tylko ASCII
  color: number; // numer koloru AutoCAD (1 czerwony, 3 zielony, 5 niebieski, 7 biały/czarny...)
  lines: number[][]; // [x1, y1, x2, y2]
  texts?: { x: number; y: number; h: number; s: string }[];
}

/** Prostokąt jako 4 odcinki. */
export const rect = (x: number, y: number, w: number, h: number): number[][] => [
  [x, y, x + w, y], [x + w, y, x + w, y + h], [x + w, y + h, x, y + h], [x, y + h, x, y],
];

/** Zapisuje prosty DXF w wersji R12 (AC1009) – czytają go wszystkie programy CAD. Jednostki: mm. */
export function writeDxf(layers: DxfLayer[]): string {
  const o: (string | number)[] = [];
  const g = (code: number, v: string | number) => { o.push(code, v); };
  const f = (n: number) => n.toFixed(3);

  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$INSUNITS'); g(70, 4);
  g(0, 'ENDSEC');

  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, layers.length);
  for (const l of layers) { g(0, 'LAYER'); g(2, l.name); g(70, 0); g(62, l.color); g(6, 'CONTINUOUS'); }
  g(0, 'ENDTAB'); g(0, 'ENDSEC');

  g(0, 'SECTION'); g(2, 'ENTITIES');
  for (const l of layers) {
    for (const [x1, y1, x2, y2] of l.lines) {
      g(0, 'LINE'); g(8, l.name);
      g(10, f(x1)); g(20, f(y1)); g(30, f(0));
      g(11, f(x2)); g(21, f(y2)); g(31, f(0));
    }
    for (const t of l.texts ?? []) {
      g(0, 'TEXT'); g(8, l.name);
      g(10, f(t.x)); g(20, f(t.y)); g(30, f(0));
      g(40, f(t.h)); g(1, t.s);
    }
  }
  g(0, 'ENDSEC'); g(0, 'EOF');
  return o.join('\r\n') + '\r\n';
}

export function downloadText(name: string, text: string, mime = 'application/dxf') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  a.click();
}
