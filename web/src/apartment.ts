import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import init, { Apartment } from './pkg/meblarz_core.js';
import { downloadText, parseDxf, rect, writeDxf, type DxfData } from './dxf';
import { applyRenames, boxGeometry, getTexture, getTextureData, importTextures, unpackFurniture, usedTextures } from './textures';

type V2 = [number, number];
type V3 = [number, number, number];
interface Opening { id: number; kind: string; pos: number; width: number; height: number; sill: number }
interface Wall { id: number; a: V2; b: V2; thickness: number; height: number; openings: Opening[] }
interface Inst { id: number; name: string; pos: V2; rot: number }
interface Box { inst: number; name: string; pos: V3; size: V3; color: string; texture: string; tex_size: number; tex_rot: boolean }
type Mode = 'select' | 'wall' | 'scale';
type Sel = { kind: 'wall' | 'inst'; id: number } | null;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const num = (id: string) => Number($<HTMLInputElement>(id).value);
const checked = (id: string) => $<HTMLInputElement>(id).checked;
const LIB_KEY = 'meblarz:library';
const ORTHO_H = 10000; // wysokość widoku 2D przy zoom = 1 (mm)

async function main() {
  await init();
  const ap = new Apartment();
  let walls: Wall[] = [], insts: Inst[] = [], boxes: Box[] = [];
  let sel: Sel = null;
  let selOp: number | null = null; // zaznaczony otwór w zaznaczonej ścianie
  let mode: Mode = 'select';
  let is2d = true;
  let chain: V2 | null = null; // ostatni punkt rysowanej ściany
  let scalePts: V2[] = [];
  let pickables: THREE.Mesh[] = [];

  // ---------- scena ----------
  const view = $<HTMLDivElement>('view');
  const tip = $<HTMLDivElement>('tip');
  const xh = document.createElement('div'); // własny celownik (systemowy kursor bywa niewidoczny na ciemnym tle)
  xh.className = 'xh';
  view.appendChild(xh);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  view.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1b1d22);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.3));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(3000, 8000, 4000);
  scene.add(sun);
  const grid = new THREE.GridHelper(40000, 40, 0x555a66, 0x2c2f37); // 1 m
  grid.position.y = -1;
  scene.add(grid);

  const persp = new THREE.PerspectiveCamera(45, 1, 10, 200000);
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 100000);
  let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = persp;
  const orbit = new OrbitControls(persp, renderer.domElement);

  const resize = () => {
    const w = view.clientWidth, h = view.clientHeight;
    renderer.setSize(w, h);
    persp.aspect = w / h;
    persp.updateProjectionMatrix();
    ortho.top = ORTHO_H / 2;
    ortho.bottom = -ORTHO_H / 2;
    ortho.right = (ORTHO_H / 2) * (w / h);
    ortho.left = -ortho.right;
    ortho.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  resize();
  renderer.setAnimationLoop(() => { orbit.update(); updateWallLabels(); scaleWallHandles(); renderer.render(scene, camera); });
  renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
  renderer.domElement.addEventListener('pointerleave', () => { xh.style.display = 'none'; });

  /** Ile mm przypada na 1 piksel ekranu (widok 2D). */
  const mmPerScreenPx = () => (ORTHO_H / ortho.zoom) / view.clientHeight;

  function applyMouse() {
    orbit.enableRotate = !is2d;
    orbit.mouseButtons.LEFT = mode === 'select' ? (is2d ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE) : null;
    orbit.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    renderer.domElement.style.cursor = mode === 'select' ? '' : 'none';
  }

  function setView(to2d: boolean) {
    is2d = to2d;
    const t = orbit.target;
    t.y = 0;
    if (to2d) {
      camera = ortho;
      ortho.up.set(0, 0, -1); // "góra" ekranu = -Z, tak jak obraz rzutu
      ortho.position.set(t.x, 5000, t.z);
    } else {
      camera = persp;
      persp.up.set(0, 1, 0);
      persp.position.set(t.x + 3000, 3500, t.z + 4500);
    }
    orbit.object = camera;
    $('v2d').classList.toggle('on', to2d);
    $('v3d').classList.toggle('on', !to2d);
    applyMouse();
    orbit.update();
  }

  function setMode(m: Mode) {
    mode = m;
    chain = null;
    scalePts = [];
    preview.visible = false;
    tip.style.display = 'none';
    xh.style.display = 'none';
    for (const [id, k] of [['tselect', 'select'], ['twall', 'wall'], ['tscale', 'scale']] as const) {
      $(id).classList.toggle('on', k === m);
    }
    if (m !== 'select' && !is2d) setView(true);
    applyMouse();
  }

  // ---------- rzut mieszkania (obraz-podkład) ----------
  let plan: { dataUrl: string; mmPerPx: number } | null = null;
  let planMesh: THREE.Mesh | null = null;
  let planPx: V2 = [1, 1];

  function applyPlanScale() {
    if (planMesh && plan) planMesh.scale.set(planPx[0] * plan.mmPerPx, 1, planPx[1] * plan.mmPerPx);
  }
  function fitPlan() {
    if (!plan) return;
    const w = planPx[0] * plan.mmPerPx, h = planPx[1] * plan.mmPerPx;
    ortho.zoom = Math.min((ORTHO_H * (view.clientWidth / view.clientHeight)) / w, ORTHO_H / h) * 0.9;
    ortho.updateProjectionMatrix();
    orbit.target.set(0, 0, 0);
    if (is2d) ortho.position.set(0, 5000, 0);
    orbit.update();
  }
  function setPlan(dataUrl: string, mmPerPx: number) {
    new THREE.TextureLoader().load(dataUrl, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      if (planMesh) { scene.remove(planMesh); (planMesh.material as THREE.Material).dispose(); }
      planPx = [tex.image.width, tex.image.height];
      plan = { dataUrl, mmPerPx };
      planMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: num('opacity'), depthWrite: false }));
      planMesh.position.y = -2;
      scene.add(planMesh);
      applyPlanScale();
      fitPlan();
    });
  }
  $('opacity').addEventListener('input', () => {
    if (planMesh) (planMesh.material as THREE.MeshBasicMaterial).opacity = num('opacity');
  });
  $('planbtn').onclick = () => $('planfile').click();
  $('planfile').addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const r = new FileReader();
    r.onload = () => { setPlan(r.result as string, 10); alert('Teraz kliknij „Ustaw skalę rzutu" i wskaż dwa punkty o znanej odległości.'); };
    r.readAsDataURL(file);
  });

  // ---------- podkład z pliku DXF ----------
  let dxf: DxfData | null = null;
  let cadCenter: V2 = [0, 0]; // środek rysunku w jednostkach pliku
  const cadVisible = new Map<string, boolean>();
  const cadGroup = new THREE.Group();
  cadGroup.position.y = 1;
  scene.add(cadGroup);
  const cadMat = new THREE.LineBasicMaterial({ color: 0x7fb2ff, transparent: true, opacity: 0.85 });

  const cadScale = () => {
    const v = $<HTMLSelectElement>('dxfunit').value;
    return v === 'auto' ? dxf?.unitScale ?? 1 : Number(v);
  };
  /** Współrzędne z pliku -> mieszkanie (mm). Oś Y rysunku to nasza -Z, więc widok z góry się zgadza. */
  const cadPt = (x: number, y: number): V2 => {
    const k = cadScale();
    return [(x - cadCenter[0]) * k, -(y - cadCenter[1]) * k];
  };

  function rebuildCad() {
    for (const l of [...cadGroup.children]) { cadGroup.remove(l); (l as THREE.LineSegments).geometry.dispose(); }
    if (!dxf) return;
    for (const [name, segs] of dxf.layers) {
      if (!cadVisible.get(name)) continue;
      const pos: number[] = [];
      for (const s of segs) {
        const [ax, az] = cadPt(s[0], s[1]);
        const [bx, bz] = cadPt(s[2], s[3]);
        pos.push(ax, 0, az, bx, 0, bz);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const ls = new THREE.LineSegments(g, cadMat);
      ls.frustumCulled = false;
      cadGroup.add(ls);
    }
  }

  function loadCad(text: string) {
    const d = parseDxf(text);
    if (!d.layers.size) throw new Error('W pliku nie znaleziono linii, polilinii, łuków ani okręgów.');
    dxf = d;
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const segs of d.layers.values()) for (const s of segs) {
      minx = Math.min(minx, s[0], s[2]); maxx = Math.max(maxx, s[0], s[2]);
      miny = Math.min(miny, s[1], s[3]); maxy = Math.max(maxy, s[1], s[3]);
    }
    cadCenter = [(minx + maxx) / 2, (miny + maxy) / 2]; // rysunek ląduje na środku sceny
    cadVisible.clear();
    const box = $('cadlayers');
    box.replaceChildren(...[...d.layers].map(([name, segs]) => {
      cadVisible.set(name, true);
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.onchange = () => { cadVisible.set(name, cb.checked); rebuildCad(); };
      label.append(cb, ` ${name} (${segs.length})`);
      return label;
    }));
    const skipped = Object.entries(d.skipped).map(([k, v]) => `${k}: ${v}`).join(', ');
    $('cadinfo').textContent =
      `Wczytano ${d.layers.size} warstw. Jednostki: ${d.unitKnown ? 'z pliku' : 'brak w pliku – sprawdź wybór poniżej'}.` +
      (skipped ? ` Pominięto: ${skipped}.` : '');
    $('cadbtns').style.display = 'flex';
    rebuildCad();
    const k = cadScale();
    fitTo((maxx - minx) * k, (maxy - miny) * k);
  }

  function fitTo(w: number, h: number) {
    ortho.zoom = Math.min((ORTHO_H * (view.clientWidth / view.clientHeight)) / Math.max(w, 1), ORTHO_H / Math.max(h, 1)) * 0.9;
    ortho.updateProjectionMatrix();
    orbit.target.set(0, 0, 0);
    if (is2d) ortho.position.set(0, 5000, 0);
    orbit.update();
  }

  $('dxfimport').onclick = () => $('dxffile').click();
  $('dxffile').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (/\.dwg$/i.test(file.name)) {
      alert('Pliki DWG są formatem zamkniętym i nie da się ich wczytać bezpośrednio w przeglądarce.\n\n' +
        'Zapisz rysunek jako DXF: w AutoCAD „Zapisz jako…" → DXF. Bez AutoCADa otwórz DWG w LibreCAD i zapisz jako DXF.');
      return;
    }
    try { loadCad(await file.text()); }
    catch (err) { alert(err instanceof Error ? err.message : 'Nie udało się wczytać DXF.'); }
  });
  $('dxfunit').addEventListener('change', () => {
    if (!dxf) return;
    rebuildCad();
  });
  $('cadclear').onclick = () => {
    dxf = null;
    rebuildCad();
    $('cadlayers').replaceChildren();
    $('cadinfo').textContent = '';
    $('cadbtns').style.display = 'none';
  };
  $('cadwalls').onclick = () => {
    if (!dxf) return;
    const segs: V2[][] = [];
    for (const [name, list] of dxf.layers) {
      if (!cadVisible.get(name)) continue;
      for (const s of list) {
        if (s[4]) continue; // łuki i okręgi pomijamy
        const a = cadPt(s[0], s[1]), b = cadPt(s[2], s[3]);
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) >= 50) segs.push([a, b]);
      }
    }
    if (!segs.length) { alert('Zaznaczone warstwy nie zawierają prostych odcinków dłuższych niż 50 mm.'); return; }
    if (segs.length > 300 && !confirm(`Utworzyć ${segs.length} ścian? To może być dużo – lepiej zaznaczyć tylko warstwę ze ścianami.`)) return;
    act(() => { for (const [a, b] of segs) ap.add_wall(a[0], a[1], b[0], b[1], num('wt'), num('wh')); });
  };

  // eksport planu: ściany i obrysy płyt mebli (widok z góry, mm)
  $('dxfexport').onclick = () => {
    const wl: number[][] = [], dl: number[][] = [], wn: number[][] = [];
    for (const w of walls) {
      const dx = w.b[0] - w.a[0], dz = w.b[1] - w.a[1];
      const len = Math.hypot(dx, dz) || 1;
      const [ux, uz] = [dx / len, dz / len];
      const h = w.thickness / 2;
      const n: V2 = [-uz * h, ux * h];
      // fragment ściany od s0 do s1 (po osi od A) jako prostokąt; oś Y rysunku = -Z
      const quad = (s0: number, s1: number, out: number[][]) => {
        const P = (s: number, side: number): V2 => [w.a[0] + ux * s + n[0] * side, w.a[1] + uz * s + n[1] * side];
        const c = [P(s0, 1), P(s1, 1), P(s1, -1), P(s0, -1)];
        for (let i = 0; i < 4; i++) out.push([c[i][0], -c[i][1], c[(i + 1) % 4][0], -c[(i + 1) % 4][1]]);
      };
      const ops = w.openings
        .map((o) => ({ s0: Math.max(0, o.pos), s1: Math.min(len, o.pos + o.width), kind: o.kind }))
        .filter((o) => o.s1 > o.s0)
        .sort((p, q) => p.s0 - q.s0);
      let s = -h;
      for (const o of ops) {
        if (o.s0 > s) quad(s, o.s0, wl);
        quad(o.s0, o.s1, o.kind === 'door' ? dl : wn);
        s = Math.max(s, o.s1);
      }
      if (len + h > s) quad(s, len + h, wl);
    }
    const fl: number[][] = [];
    for (const b of boxes) fl.push(...rect(b.pos[0], -(b.pos[2] + b.size[2]), b.size[0], b.size[2]));
    downloadText('mieszkanie.dxf', writeDxf([
      { name: 'SCIANY', color: 5, lines: wl },
      { name: 'DRZWI', color: 1, lines: dl },
      { name: 'OKNA', color: 4, lines: wn },
      { name: 'MEBLE', color: 3, lines: fl },
    ]));
  };

  // ---------- budowa sceny z danych Rusta ----------
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const unitEdges = new THREE.EdgesGeometry(unitBox);
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x222222 });
  const mat = {
    wall: new THREE.MeshStandardMaterial({ color: 0x8a8f9c }),
    wallSel: new THREE.MeshStandardMaterial({ color: 0xf2c14e }),
    inst: new THREE.MeshStandardMaterial({ color: 0xc8a574 }),
    instSel: new THREE.MeshStandardMaterial({ color: 0xf2c14e }),
    glass: new THREE.MeshStandardMaterial({ color: 0x8ecae6, transparent: true, opacity: 0.35 }),
    opening: new THREE.MeshBasicMaterial({ color: 0xf2c14e, transparent: true, opacity: 0.45, depthTest: false }),
  };
  const wallGroup = new THREE.Group();
  const instGroup = new THREE.Group();
  scene.add(wallGroup, instGroup);

  // uchwyty zaznaczonej ściany: cyjanowe = koniec (wydłużanie), różowe = bok (grubość)
  const whandles = new THREE.Group();
  const WH: [string, number, number][] = [['end', 0, 0x5ec8e5], ['end', 1, 0x5ec8e5], ['face', 1, 0xff5ccd], ['face', -1, 0xff5ccd]];
  for (const [kind, idx, color] of WH) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true }));
    m.renderOrder = 999;
    m.userData = { kind, idx };
    whandles.add(m);
  }
  whandles.visible = false;
  scene.add(whandles);

  function updateWallHandles() {
    const w = sel?.kind === 'wall' ? walls.find((x) => x.id === sel!.id) : undefined;
    whandles.visible = !!w;
    if (!w) return;
    const dx = w.b[0] - w.a[0], dz = w.b[1] - w.a[1];
    const len = Math.hypot(dx, dz) || 1;
    const u: V2 = [dx / len, dz / len], n: V2 = [-u[1], u[0]];
    const h = w.thickness / 2, y = w.height + 10;
    const mid: V2 = [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2];
    const pos: V3[] = [
      [w.a[0] - u[0] * h, y, w.a[1] - u[1] * h], // czubek końca A
      [w.b[0] + u[0] * h, y, w.b[1] + u[1] * h], // czubek końca B
      [mid[0] + n[0] * h, y, mid[1] + n[1] * h],
      [mid[0] - n[0] * h, y, mid[1] - n[1] * h],
    ];
    whandles.children.forEach((m, i) => m.position.set(...pos[i]));
  }
  function scaleWallHandles() {
    if (!whandles.visible) return;
    for (const m of whandles.children) {
      m.scale.setScalar(camera === ortho ? mmPerScreenPx() * 7 : camera.position.distanceTo(m.position) * 0.01);
    }
  }

  // materiały i bryły mebli (kolory, tekstury z biblioteki), buforowane
  const instMats = new Map<string, THREE.MeshStandardMaterial>();
  function instMaterial(color: string, texture: string, selected: boolean) {
    const tex = texture ? getTexture(texture) : null;
    const key = `${color}|${tex ? texture : ''}|${selected}`;
    let m = instMats.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color: tex ? 0xffffff : color || 0xc8a574, map: tex });
      m.emissive.set(selected ? 0x6b5200 : 0x000000);
      instMats.set(key, m);
    }
    return m;
  }
  const geoCache = new Map<string, THREE.BoxGeometry>();
  function boxGeo(b: Box) {
    const key = `${b.size.join(',')}|${b.tex_size}|${b.tex_rot}`;
    let g = geoCache.get(key);
    if (!g) { g = boxGeometry(b.size, b.tex_size, b.tex_rot); geoCache.set(key, g); }
    return g;
  }

  /** Kawałki ściany wokół otworów: [od, do (po osi od A), dół, góra]. Ściana ma nadmiar pół grubości na końcach. */
  function wallPieces(w: Wall): [number, number, number, number][] {
    const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    const h = w.thickness / 2;
    const ops = w.openings
      .map((o) => ({ s0: Math.max(0, o.pos), s1: Math.min(len, o.pos + o.width), y0: o.sill, y1: Math.min(w.height, o.sill + o.height) }))
      .filter((o) => o.s1 > o.s0 && o.y1 > o.y0)
      .sort((p, q) => p.s0 - q.s0);
    const out: [number, number, number, number][] = [];
    let s = -h;
    for (const o of ops) {
      if (o.s0 > s) out.push([s, o.s0, 0, w.height]);
      if (o.y0 > 0) out.push([o.s0, o.s1, 0, o.y0]);           // pod oknem
      if (o.y1 < w.height) out.push([o.s0, o.s1, o.y1, w.height]); // nad otworem
      s = Math.max(s, o.s1);
    }
    if (len + h > s) out.push([s, len + h, 0, w.height]);
    return out;
  }

  function rebuild() {
    wallGroup.clear();
    instGroup.clear();
    pickables = [];
    for (const w of walls) {
      const dx = w.b[0] - w.a[0], dz = w.b[1] - w.a[1];
      const len = Math.hypot(dx, dz) || 1;
      const ux = dx / len, uz = dz / len;
      const material = sel?.kind === 'wall' && sel.id === w.id ? mat.wallSel : mat.wall;
      const place = (m: THREE.Mesh, s0: number, s1: number, y0: number, y1: number, thick: number) => {
        m.scale.set(s1 - s0, y1 - y0, thick);
        const sc = (s0 + s1) / 2;
        m.position.set(w.a[0] + ux * sc, (y0 + y1) / 2, w.a[1] + uz * sc);
        m.rotation.y = -Math.atan2(dz, dx);
      };
      for (const [s0, s1, y0, y1] of wallPieces(w)) {
        const m = new THREE.Mesh(unitBox, material);
        place(m, s0, s1, y0, y1, w.thickness);
        m.add(new THREE.LineSegments(unitEdges, edgeMat));
        m.userData = { kind: 'wall', id: w.id };
        wallGroup.add(m);
        pickables.push(m);
      }
      for (const o of w.openings) {
        const s0 = Math.max(0, o.pos), s1 = Math.min(len, o.pos + o.width), y1 = Math.min(w.height, o.sill + o.height);
        if (s1 <= s0 || y1 <= o.sill) continue;
        if (o.kind === 'window') {
          const g = new THREE.Mesh(unitBox, mat.glass); // szyba
          place(g, s0, s1, o.sill, y1, 20);
          wallGroup.add(g);
        }
        if (sel?.kind === 'wall' && sel.id === w.id && selOp === o.id) {
          const hl = new THREE.Mesh(unitBox, mat.opening); // podświetlenie zaznaczonego otworu
          place(hl, s0, s1, o.sill, y1, w.thickness + 30);
          wallGroup.add(hl);
        }
      }
    }
    for (const b of boxes) {
      const m = new THREE.Mesh(boxGeo(b), instMaterial(b.color, b.texture, sel?.kind === 'inst' && sel.id === b.inst));
      m.position.set(b.pos[0] + b.size[0] / 2, b.pos[1] + b.size[1] / 2, b.pos[2] + b.size[2] / 2);
      const edges = new THREE.LineSegments(unitEdges, edgeMat);
      edges.scale.set(...b.size);
      m.add(edges);
      m.userData = { kind: 'inst', id: b.inst };
      instGroup.add(m);
      pickables.push(m);
    }
  }

  // etykiety zaznaczonej ściany: końce A i B oraz długość
  const wallLabels = [['A', '#5fd07a'], ['B', '#ff6b70'], ['', '#e6e8ec']].map(([, color]) => {
    const d = document.createElement('div');
    d.className = 'lbl';
    d.style.color = color;
    d.style.display = 'none';
    view.appendChild(d);
    return d;
  });
  function updateWallLabels() {
    const w = sel?.kind === 'wall' ? walls.find((x) => x.id === sel!.id) : undefined;
    const W = view.clientWidth, H = view.clientHeight;
    wallLabels.forEach((el, i) => {
      if (!w) { el.style.display = 'none'; return; }
      const p: V2 = i === 0 ? w.a : i === 1 ? w.b : [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2];
      const v = new THREE.Vector3(p[0], w.height, p[1]).project(camera);
      if (v.z > 1) { el.style.display = 'none'; return; }
      el.style.display = 'block';
      el.style.left = `${(v.x * 0.5 + 0.5) * W}px`;
      el.style.top = `${(-v.y * 0.5 + 0.5) * H}px`;
      el.textContent = i === 2 ? `${Math.round(Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]))} mm` : i === 0 ? 'A' : 'B';
    });
  }

  function syncOpenings(w: Wall | undefined, force = false) {
    if (!w) return;
    if (!w.openings.some((o) => o.id === selOp)) {
      const first = w.openings[0]?.id ?? null;
      if (first !== selOp) { selOp = first; rebuild(); }
    }
    const opSelect = $<HTMLSelectElement>('opsel');
    opSelect.replaceChildren(...w.openings.map((o, k) => {
      const op = document.createElement('option');
      op.value = String(o.id);
      op.textContent = `${o.kind === 'door' ? 'Drzwi' : 'Okno'} ${k + 1}: ${o.width}×${o.height}`;
      return op;
    }));
    const o = w.openings.find((x) => x.id === selOp);
    $('opfields').style.display = o ? 'block' : 'none';
    opSelect.style.display = w.openings.length ? 'block' : 'none';
    if (!o) return;
    opSelect.value = String(o.id);
    for (const [id, v] of [['opp', o.pos], ['opw', o.width], ['oph', o.height], ['ops', o.sill]] as const) {
      const el = $<HTMLInputElement>(id);
      if (force || document.activeElement !== el) el.value = String(Math.round(v * 10) / 10);
    }
  }

  function syncPanel() {
    updateWallHandles();
    const w = sel?.kind === 'wall' ? walls.find((x) => x.id === sel!.id) : undefined;
    const i = sel?.kind === 'inst' ? insts.find((x) => x.id === sel!.id) : undefined;
    $('wallbox').style.display = w ? 'block' : 'none';
    $('instbox').style.display = i ? 'block' : 'none';
    $('selactions').style.display = w || i ? 'block' : 'none';
    if (w) {
      const len = Math.round(Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) * 10) / 10;
      for (const [id, v] of [['swl', len], ['swt', w.thickness], ['swh', w.height]] as const) {
        const el = $<HTMLInputElement>(id);
        if (document.activeElement !== el) el.value = String(v);
      }
    }
    if (i) $('instname').textContent = `${i.name} · obrót ${i.rot * 90}°`;
    syncOpenings(w);
  }

  function refresh() {
    const st = JSON.parse(ap.to_json());
    walls = st.walls;
    insts = st.instances;
    boxes = JSON.parse(ap.world_boxes());
    if (sel && !(sel.kind === 'wall' ? walls : insts).some((x) => x.id === sel!.id)) sel = null;
    rebuild();
    syncPanel();
  }
  function select(s: Sel) { sel = s; selOp = null; rebuild(); syncPanel(); }
  function act(fn: () => void) { ap.checkpoint(); fn(); refresh(); }

  // ---------- rysowanie ścian ----------
  const preview = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    new THREE.LineBasicMaterial({ color: 0x5ec8e5, depthTest: false }));
  preview.frustumCulled = false;
  preview.renderOrder = 999;
  preview.visible = false;
  scene.add(preview);

  const ray = new THREE.Raycaster();
  const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const ndc = (e: MouseEvent) => {
    const r = renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  };
  function pickFloor(e: MouseEvent): V2 | null {
    ray.setFromCamera(ndc(e), camera);
    const p = new THREE.Vector3();
    return ray.ray.intersectPlane(floorPlane, p) ? [p.x, p.z] : null;
  }
  function pickObj(e: MouseEvent): Sel {
    ray.setFromCamera(ndc(e), camera);
    const h = ray.intersectObjects(pickables, false)[0];
    return h ? { kind: h.object.userData.kind, id: h.object.userData.id } : null;
  }
  function snapPt(raw: V2): V2 {
    const tol = checked('snap') ? Math.max(20, 12 * mmPerScreenPx()) : 0;
    return JSON.parse(ap.snap_point(raw[0], raw[1], tol, chain ? chain[0] : 0, chain ? chain[1] : 0, !!chain && checked('ortho')));
  }
  function placeCursor(p: V2) {
    const v = new THREE.Vector3(p[0], 0, p[1]).project(camera);
    xh.style.display = 'block';
    xh.style.left = `${(v.x * 0.5 + 0.5) * view.clientWidth}px`;
    xh.style.top = `${(-v.y * 0.5 + 0.5) * view.clientHeight}px`;
  }
  function updatePreview(e: MouseEvent) {
    const raw = pickFloor(e);
    if (!raw) return;
    const p = snapPt(raw);
    placeCursor(p); // celownik stoi w punkcie, do którego przyciągnie klik
    if (!chain) { preview.visible = false; tip.style.display = 'none'; return; }
    preview.geometry.setFromPoints([new THREE.Vector3(chain[0], 10, chain[1]), new THREE.Vector3(p[0], 10, p[1])]);
    preview.visible = true;
    const r = view.getBoundingClientRect();
    tip.style.display = 'block';
    tip.style.left = `${e.clientX - r.left + 14}px`;
    tip.style.top = `${e.clientY - r.top + 14}px`;
    tip.textContent = `${Math.round(Math.hypot(p[0] - chain[0], p[1] - chain[1]))} mm`;
  }
  function wallClick(e: MouseEvent) {
    const raw = pickFloor(e);
    if (!raw) return;
    const p = snapPt(raw);
    if (!chain) { chain = p; return; }
    act(() => { ap.add_wall(chain![0], chain![1], p[0], p[1], num('wt'), num('wh')); });
    chain = p;
  }
  function scaleClick(e: MouseEvent) {
    const raw = pickFloor(e);
    if (!raw) return;
    scalePts.push(raw);
    if (scalePts.length < 2) { tip.style.display = 'block'; tip.textContent = 'Wskaż drugi punkt'; return; }
    const dist = Math.hypot(scalePts[1][0] - scalePts[0][0], scalePts[1][1] - scalePts[0][1]);
    const answer = prompt('Jaka jest rzeczywista odległość między tymi punktami? (mm)', '1000');
    const real = Number((answer ?? '').replace(',', '.'));
    if (plan && dist > 1 && real > 0) {
      plan.mmPerPx *= real / dist;
      applyPlanScale();
      fitPlan();
    } else if (!plan) {
      alert('Najpierw wczytaj rzut.');
    }
    setMode('select');
  }

  // ---------- mysz ----------
  let down: { x: number; y: number } | null = null;
  let drag: { id: number; off: V2 } | null = null;
  let wdrag: { id: number; off: V2 } | null = null; // przesuwanie całej ściany
  let hdrag: { kind: 'end' | 'face'; id: number; idx: number; grab: number } | null = null; // uchwyt ściany
  const wallTol = () => (checked('snap') ? Math.max(20, 12 * mmPerScreenPx()) : 0);
  const snapTol = () => (checked('snap') ? num('tol') : 0);

  // faza "capture": kliknięcie w mebel/ścianę ma pierwszeństwo przed przesuwaniem widoku
  view.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY };
    if (e.button !== 0 || mode !== 'select') return;
    const selWall = sel?.kind === 'wall' ? walls.find((w) => w.id === sel!.id) : undefined;
    if (selWall) {
      ray.setFromCamera(ndc(e), camera);
      const h = ray.intersectObjects(whandles.children, false)[0];
      const p0 = h ? pickFloor(e) : null;
      if (h && p0) {
        e.stopPropagation();
        const [ax, az] = selWall.a, [bx, bz] = selWall.b;
        const len = Math.hypot(bx - ax, bz - az) || 1;
        const u: V2 = [(bx - ax) / len, (bz - az) / len], n: V2 = [-u[1], u[0]];
        const ud = h.object.userData as { kind: 'end' | 'face'; idx: number };
        if (ud.kind === 'end') {
          const fixed = ud.idx === 0 ? selWall.b : selWall.a;
          const d: V2 = ud.idx === 0 ? [-u[0], -u[1]] : u;
          hdrag = { kind: 'end', id: selWall.id, idx: ud.idx, grab: len - ((p0[0] - fixed[0]) * d[0] + (p0[1] - fixed[1]) * d[1]) };
        } else {
          hdrag = { kind: 'face', id: selWall.id, idx: ud.idx, grab: (ud.idx * selWall.thickness) / 2 - ((p0[0] - ax) * n[0] + (p0[1] - az) * n[1]) };
        }
        ap.checkpoint();
        return;
      }
    }
    const hit = pickObj(e);
    if (!hit) return;
    e.stopPropagation();
    select(hit);
    if (hit.kind === 'inst') {
      const f = pickFloor(e);
      const inst = insts.find((x) => x.id === hit.id);
      if (f && inst) { drag = { id: hit.id, off: [inst.pos[0] - f[0], inst.pos[1] - f[1]] }; ap.checkpoint(); }
    } else {
      const f = pickFloor(e);
      const w = walls.find((x) => x.id === hit.id);
      if (f && w) { wdrag = { id: w.id, off: [w.a[0] - f[0], w.a[1] - f[1]] }; ap.checkpoint(); }
    }
  }, true);

  window.addEventListener('pointermove', (e) => {
    if (hdrag) {
      const f = pickFloor(e);
      if (f) {
        if (hdrag.kind === 'end') ap.drag_wall_end(hdrag.id, hdrag.idx, f[0], f[1], hdrag.grab, wallTol(), checked('swconn'));
        else ap.drag_wall_face(hdrag.id, hdrag.idx, f[0], f[1], hdrag.grab, wallTol());
        refresh();
      }
    } else if (wdrag) {
      const f = pickFloor(e);
      if (f) { ap.move_wall(wdrag.id, f[0] + wdrag.off[0], f[1] + wdrag.off[1], wallTol(), checked('swconn')); refresh(); }
    } else if (drag) {
      const f = pickFloor(e);
      if (f) { ap.move_instance(drag.id, f[0] + drag.off[0], f[1] + drag.off[1], snapTol()); refresh(); }
    } else if (mode === 'wall' && e.target === renderer.domElement) {
      updatePreview(e);
    } else if (mode === 'scale' && e.target === renderer.domElement) {
      const r = pickFloor(e);
      if (r) placeCursor(r);
    }
  });

  window.addEventListener('pointerup', (e) => {
    if (drag || wdrag || hdrag) { drag = null; wdrag = null; hdrag = null; down = null; return; }
    const d = down;
    down = null;
    if (!d || e.target !== renderer.domElement) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return; // to było przesuwanie widoku
    if (mode === 'select' && e.button === 0) select(null);
    else if (mode === 'wall') {
      if (e.button === 0) wallClick(e);
      else if (e.button === 2) { chain = null; preview.visible = false; tip.style.display = 'none'; }
    } else if (mode === 'scale' && e.button === 0) scaleClick(e);
  });

  // ---------- panel boczny ----------
  $('tselect').onclick = () => setMode('select');
  $('twall').onclick = () => setMode('wall');
  $('tscale').onclick = () => { setMode('scale'); tip.style.display = 'block'; tip.textContent = 'Wskaż pierwszy punkt'; tip.style.left = '16px'; tip.style.top = '16px'; };
  $('v2d').onclick = () => setView(true);
  $('v3d').onclick = () => { setMode('select'); setView(false); };

  for (const k of ['swt', 'swh']) $(k).addEventListener('change', () => {
    if (sel?.kind === 'wall') act(() => ap.set_wall(sel!.id, num('swt'), num('swh')));
  });
  $('swl').addEventListener('change', () => {
    if (sel?.kind !== 'wall') return;
    const id = sel.id;
    act(() => ap.set_wall_length(id, num('swl'), Number($<HTMLSelectElement>('swanchor').value), checked('swconn')));
  });
  function addOpening(kind: 'door' | 'window') {
    if (sel?.kind !== 'wall') return;
    const id = sel.id;
    let oid = 0;
    act(() => { oid = kind === 'door' ? ap.add_opening(id, 'door', 900, 2050, 0) : ap.add_opening(id, 'window', 1200, 1200, 900); });
    if (!oid) alert('Na tej ścianie nie ma miejsca na ten otwór.');
    else { selOp = oid; refresh(); }
  }
  $('adddoor').onclick = () => addOpening('door');
  $('addwin').onclick = () => addOpening('window');
  $('opsel').addEventListener('change', () => { selOp = Number($<HTMLSelectElement>('opsel').value); rebuild(); syncPanel(); });
  for (const k of ['opp', 'opw', 'oph', 'ops']) $(k).addEventListener('change', () => {
    if (sel?.kind !== 'wall' || selOp === null) return;
    const wid = sel.id, oid = selOp;
    let ok = true;
    act(() => { ok = ap.set_opening(wid, oid, num('opp'), num('opw'), num('oph'), num('ops')); });
    if (!ok) {
      alert('Taki otwór się nie zmieści (wychodzi poza ścianę, jest za wysoki albo nachodzi na inny otwór).');
      syncOpenings(walls.find((x) => x.id === wid), true);
    }
  });
  $('opdel').onclick = () => {
    if (sel?.kind !== 'wall' || selOp === null) return;
    const wid = sel.id, oid = selOp;
    selOp = null;
    act(() => ap.remove_opening(wid, oid));
  };

  function nudge(key: string, step: number) {
    if (!sel) return;
    const id = sel.id;
    const dx = key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0;
    const dz = key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0;
    if (sel.kind === 'wall') {
      const w = walls.find((x) => x.id === id);
      if (w) act(() => ap.move_wall(id, w.a[0] + dx, w.a[1] + dz, 0, checked('swconn')));
    } else {
      const i = insts.find((x) => x.id === id);
      if (i) act(() => ap.move_instance(id, i.pos[0] + dx, i.pos[1] + dz, 0));
    }
  }
  const remove = () => { if (sel) { const id = sel.id; sel = null; act(() => ap.remove(Uint32Array.of(id))); } };
  const rotate = () => { if (sel?.kind === 'inst') act(() => ap.rotate_instance(sel!.id)); };
  $('del').onclick = remove;
  $('rot').onclick = rotate;

  // ---------- biblioteka mebli ----------
  const readLib = (): Record<string, string> => {
    try { return JSON.parse(localStorage.getItem(LIB_KEY) ?? '{}'); } catch { return {}; }
  };
  function fillLib() {
    const lib = readLib();
    $<HTMLSelectElement>('lib').replaceChildren(...Object.keys(lib).map((n) => {
      const o = document.createElement('option');
      o.value = o.textContent = n;
      return o;
    }));
  }
  function insertFurniture(name: string, json: string) {
    let id = 0;
    ap.checkpoint();
    id = ap.add_instance(name, json, orbit.target.x, orbit.target.z);
    if (!id) { alert('Nie udało się wczytać tego mebla (nieprawidłowy plik).'); return; }
    refresh();
    select({ kind: 'inst', id });
  }
  fillLib();
  $('libreload').onclick = fillLib;
  $('libadd').onclick = () => {
    const name = $<HTMLSelectElement>('lib').value;
    const json = readLib()[name];
    if (json) insertFurniture(name, json);
    else alert('Biblioteka jest pusta. W edytorze mebli kliknij „Do biblioteki".');
  };
  $('libfile').onclick = () => $('furnfile').click();
  $('furnfile').addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const u = unpackFurniture(await file.text());
      let json = u.panelsJson;
      if (Object.keys(u.textures).length) {
        const r = importTextures(u.textures); // tekstury z pliku trafiają do biblioteki
        json = applyRenames(json, r.renames);
        if (r.failed.length) alert(`Nie zmieściły się w pamięci przeglądarki tekstury: ${r.failed.join(', ')}.`);
      }
      insertFurniture(file.name.replace(/\.json$/i, ''), json);
    } catch { alert('Nieprawidłowy plik mebla.'); }
  });

  // ---------- zapis / odczyt ----------
  $('save').onclick = () => {
    const state = JSON.parse(ap.to_json());
    const textures: Record<string, string> = {}; // użyte tekstury wbudowane w plik
    for (const n of usedTextures(state.instances.flatMap((i: { panels: { texture?: string }[] }) => i.panels))) {
      const d = getTextureData(n);
      if (d) textures[n] = d;
    }
    const out = { version: 2, state, plan, textures };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(out)], { type: 'application/json' }));
    a.download = 'mieszkanie.json';
    a.click();
  };
  $('load').onclick = () => $('aptfile').click();
  $('aptfile').addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.textures && Object.keys(data.textures).length) {
        const r = importTextures(data.textures);
        for (const inst of data.state.instances ?? []) {
          for (const p of inst.panels ?? []) if (p.texture && r.renames[p.texture]) p.texture = r.renames[p.texture];
        }
        if (r.failed.length) alert(`Nie zmieściły się w pamięci przeglądarki tekstury: ${r.failed.join(', ')}.`);
      }
      ap.checkpoint();
      if (!ap.load_json(JSON.stringify(data.state))) throw new Error('bad state');
      sel = null;
      refresh();
      if (data.plan) setPlan(data.plan.dataUrl, data.plan.mmPerPx);
    } catch { alert('Nieprawidłowy plik mieszkania'); }
  });

  // ---------- skróty ----------
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLInputElement && (t.type === 'text' || t.type === 'number')) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (ctrl && k === 'z' && !e.shiftKey) { if (ap.undo()) refresh(); }
    else if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) { if (ap.redo()) refresh(); }
    else if (k === 'delete' || k === 'backspace') remove();
    else if (!ctrl && k === 'r') rotate();
    else if (k.startsWith('arrow') && sel) nudge(k, e.shiftKey ? 1 : 10);
    else if (k === 'escape') {
      if (mode !== 'select') setMode(mode === 'wall' && chain ? 'wall' : 'select');
      else select(null);
    }
    else return;
    e.preventDefault();
  });

  setView(true);
  applyMouse();
  refresh();
}

main();
