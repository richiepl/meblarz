import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import init, { Furniture } from './pkg/meblarz_core.js';
import { downloadText, rect, writeDxf } from './dxf';
import { makeCollapsible } from './collapse';
import { PALETTE, addCustomColor, addTexture, applyRenames, boxGeometry, colorName, getTexture, imageToDataUrl, importTextures, packFurniture, readCustomPalette, removeCustomColor, removeTexture, textureNames, unpackFurniture } from './textures';

type V3 = [number, number, number];
type ViewName = 'persp' | 'front' | 'side' | 'top';
interface Hole { id: number; kind: string; face: number; u: number; v: number; dia: number; depth: number }
interface PanelData { id: number; name: string; size: V3; pos: V3; group: number; edging: boolean[]; edge_mm: number; inset: number[]; material: string; holes: Hole[]; color: string; texture: string; tex_size: number; tex_rot: boolean }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const num = (id: string) => Number($<HTMLInputElement>(id).value);

const PRESETS: Record<string, [string, number, number, number]> = {
  bok: ['Bok', 18, 720, 500],
  poziom: ['Dno/półka', 764, 18, 500],
  tyl: ['Tył', 764, 720, 3],
  wlasna: ['Płyta', 600, 18, 400],
};
const COLOR_NORMAL = 0xc8a574, COLOR_GROUP = 0xb7c98a, COLOR_SEL = 0xf2c14e, COLOR_GUIDE = 0x5ec8e5;

async function main() {
  await init();
  const sections = makeCollapsible(document.querySelector('aside')!);
  $('collapseall').onclick = () => sections.setAll(true);
  $('expandall').onclick = () => sections.setAll(false);
  $('filter').addEventListener('input', () => renderList());
  const f = new Furniture();
  let data: PanelData[] = [];
  const sel = new Set<number>();
  const meshes = new Map<number, THREE.Mesh>();
  let selHole: number | null = null; // zaznaczony otwór w zaznaczonej płycie

  // --- scena (1 jednostka = 1 mm) ---
  const view = $<HTMLDivElement>('view');
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  view.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1b1d22);
  const persp = new THREE.PerspectiveCamera(45, 1, 10, 100000);
  persp.position.set(1800, 1400, 2200);
  const ORTHO_H = 2000; // wysokość widoczna w widokach 2D przy zoom = 1 (mm)
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 50000);
  let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = persp;
  let viewName: ViewName = 'persp';
  // oś, wzdłuż której patrzymy w danym widoku 2D (0=X, 1=Y, 2=Z)
  const VIEW_AXIS: Record<Exclude<ViewName, 'persp'>, number> = { front: 2, side: 0, top: 1 };
  const orbit = new OrbitControls(persp, renderer.domElement);
  orbit.target.set(400, 350, 250);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(1000, 2000, 1500);
  scene.add(sun);
  scene.add(new THREE.GridHelper(4000, 40, 0x555a66, 0x33363e));

  // niewidzialny "uchwyt" w środku zaznaczenia; za niego ciągną strzałki
  const pivot = new THREE.Object3D();
  scene.add(pivot);
  const transform = new TransformControls(camera, renderer.domElement);
  transform.setMode('translate');
  scene.add(transform.getHelper());

  // uchwyty zmiany wymiaru: kulki na środkach ścianek pojedynczej płyty
  const handles = new THREE.Group();
  const AXIS_COLORS = [0xe5484d, 0x46a758, 0x3e63dd]; // X, Y, Z
  for (let axis = 0; axis < 3; axis++) for (let side = 0; side < 2; side++) {
    const h = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial({ color: AXIS_COLORS[axis], depthTest: false, transparent: true }));
    h.renderOrder = 999;
    h.userData = { axis, side };
    handles.add(h);
  }
  handles.visible = false;
  scene.add(handles);

  // podświetlenia przyciągania (tylko w trakcie przeciągania)
  let guideIds = new Set<number>();
  const guideLines = new THREE.Group();
  scene.add(guideLines);

  // okleina: cienkie paski na oklejonych ściankach
  const edgeGroup = new THREE.Group();
  scene.add(edgeGroup);
  const edgeMat = new THREE.MeshBasicMaterial({ color: 0x2ec4b6 });

  // otwory: ciemne tarcze na ściankach płyt
  const holeGroup = new THREE.Group();
  scene.add(holeGroup);
  const holeGeo = new THREE.CircleGeometry(1, 24);
  const holeBlind = new THREE.MeshBasicMaterial({ color: 0x3a2a1a, side: THREE.DoubleSide });
  const holeThrough = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide });

  // etykiety wymiarów (HTML nałożony na scenę)
  const labelBox = $<HTMLDivElement>('labels');
  const labels = ['#ff6b70', '#5fd07a', '#7f9bff'].map((c) => {
    const d = document.createElement('div');
    d.className = 'lbl';
    d.style.color = c;
    labelBox.appendChild(d);
    return d;
  });

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
  renderer.setAnimationLoop(() => {
    orbit.update();
    for (const h of handles.children) {
      h.scale.setScalar(camera instanceof THREE.OrthographicCamera
        ? ((camera.top - camera.bottom) / camera.zoom) * 0.0145
        : camera.position.distanceTo(h.position) * 0.012);
    }
    updateLabels();
    renderer.render(scene, camera);
  });

  // --- pomocnicze ---
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const unitEdges = new THREE.EdgesGeometry(unitBox);
  const tol = () => ($<HTMLInputElement>('snap').checked ? num('tol') : 0);
  const ids = () => data.filter((p) => sel.has(p.id)).map((p) => p.id);
  const u32 = () => Uint32Array.from(ids());
  /** Oś grubości = najkrótszy wymiar (tak samo jak w Ruście: przy remisie wygrywa wyższy numer osi). */
  const thickAxis = (s: V3) => [0, 1, 2].sort((i, j) => s[j] - s[i])[2];

  function selBox(): { min: V3; max: V3 } | null {
    const ps = data.filter((p) => sel.has(p.id));
    if (!ps.length) return null;
    const min: V3 = [Infinity, Infinity, Infinity];
    const max: V3 = [-Infinity, -Infinity, -Infinity];
    for (const p of ps) for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], p.pos[a]);
      max[a] = Math.max(max[a], p.pos[a] + p.size[a]);
    }
    return { min, max };
  }

  function allBox(): { min: V3; max: V3 } | null {
    if (!data.length) return null;
    const min: V3 = [Infinity, Infinity, Infinity];
    const max: V3 = [-Infinity, -Infinity, -Infinity];
    for (const p of data) for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], p.pos[a]);
      max[a] = Math.max(max[a], p.pos[a] + p.size[a]);
    }
    return { min, max };
  }

  /** Przełącza widok: perspektywa albo rzut prostokątny (przód / bok / góra). */
  function setView(v: ViewName) {
    viewName = v;
    document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
    const is2d = v !== 'persp';
    orbit.enableRotate = !is2d;
    orbit.mouseButtons.LEFT = is2d ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    // w 2D strzałki tylko w płaszczyźnie ekranu
    const va = is2d ? VIEW_AXIS[v as Exclude<ViewName, 'persp'>] : -1;
    transform.showX = va !== 0;
    transform.showY = va !== 1;
    transform.showZ = va !== 2;
    if (!is2d) {
      camera = persp;
      persp.up.set(0, 1, 0);
    } else {
      camera = ortho;
      const b = allBox() ?? { min: [0, 0, 0] as V3, max: [800, 720, 500] as V3 };
      const c = [0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2);
      const dir: V3 = v === 'front' ? [0, 0, 1] : v === 'side' ? [1, 0, 0] : [0, 1, 0];
      ortho.up.set(0, 0, 0).setComponent(v === 'top' ? 2 : 1, v === 'top' ? -1 : 1);
      ortho.position.set(c[0] + dir[0] * 5000, c[1] + dir[1] * 5000, c[2] + dir[2] * 5000);
      const [ha, vaxis] = v === 'front' ? [0, 1] : v === 'side' ? [2, 1] : [0, 2];
      const ew = (b.max[ha] - b.min[ha]) * 1.5 + 200;
      const eh = (b.max[vaxis] - b.min[vaxis]) * 1.5 + 200;
      ortho.zoom = Math.min((ORTHO_H * (view.clientWidth / view.clientHeight)) / ew, ORTHO_H / eh);
      ortho.updateProjectionMatrix();
      orbit.target.set(c[0], c[1], c[2]);
    }
    orbit.object = camera;
    transform.camera = camera;
    orbit.update();
    placePivot();
  }

  /** Wymiary zaznaczenia (w 2D: całego mebla) na trzech krawędziach prostopadłościanu. */
  function updateLabels() {
    const b = $<HTMLInputElement>('dims').checked ? (selBox() ?? (viewName !== 'persp' ? allBox() : null)) : null;
    const hideAxis = viewName === 'persp' ? -1 : VIEW_AXIS[viewName];
    const w = view.clientWidth, h = view.clientHeight;
    labels.forEach((el, a) => {
      if (!b || a === hideAxis) { el.style.display = 'none'; return; }
      const mid = (i: number) => (b.min[i] + b.max[i]) / 2;
      const pts: V3[] = [
        [mid(0), b.min[1], b.max[2]],
        [b.max[0], mid(1), b.max[2]],
        [b.max[0], b.min[1], mid(2)],
      ];
      const v = new THREE.Vector3(...pts[a]).project(camera);
      if (v.z > 1) { el.style.display = 'none'; return; }
      el.style.display = 'block';
      el.style.left = `${(v.x * 0.5 + 0.5) * w}px`;
      el.style.top = `${(-v.y * 0.5 + 0.5) * h}px`;
      el.textContent = String(Math.round((b.max[a] - b.min[a]) * 10) / 10);
    });
  }

  /** Zmiana użytkownika: zapamiętaj stan do cofania, wykonaj, odśwież. */
  function act(fn: () => void) { f.checkpoint(); fn(); refresh(); }

  // --- synchronizacja Rust -> scena/UI ---
  function refresh() {
    data = JSON.parse(f.to_json());
    const alive = new Set(data.map((p) => p.id));
    for (const [id, m] of meshes) {
      if (!alive.has(id)) { scene.remove(m); (m.material as THREE.Material).dispose(); meshes.delete(id); }
    }
    for (const p of data) {
      let m = meshes.get(p.id);
      if (!m) {
        m = new THREE.Mesh(unitBox, new THREE.MeshStandardMaterial({ color: COLOR_NORMAL }));
        m.add(new THREE.LineSegments(unitEdges, new THREE.LineBasicMaterial({ color: 0x222222 })));
        m.userData.id = p.id;
        scene.add(m);
        meshes.set(p.id, m);
      }
      // własna bryła z UV w mm (tekstura się nie rozciąga); przebudowa tylko po zmianie wymiaru/ustawień tekstury
      const gkey = `${p.size.join(',')}|${p.tex_size}|${p.tex_rot}`;
      if (m.userData.gkey !== gkey) {
        if (m.geometry !== unitBox) m.geometry.dispose();
        m.geometry = boxGeometry(p.size, p.tex_size, p.tex_rot);
        m.userData.gkey = gkey;
        m.children[0].scale.set(...p.size); // obrys krawędzi
      }
      m.position.set(p.pos[0] + p.size[0] / 2, p.pos[1] + p.size[1] / 2, p.pos[2] + p.size[2] / 2);
    }
    for (const id of [...sel]) if (!alive.has(id)) sel.delete(id);
    rebuildEdges(); rebuildHoles(); paint(); renderList(); syncForm(); placePivot();
  }

  /** Osie w płaszczyźnie ścianki o normalnej na osi n (tak samo jak w Ruście). */
  function faceAxes(n: number): [number, number] { return n === 0 ? [1, 2] : n === 1 ? [0, 2] : [0, 1]; }

  function rebuildHoles() {
    holeGroup.clear();
    for (const p of data) for (const h of p.holes) {
      const n = h.face >> 1, s = h.face & 1;
      const [ua, vb] = faceAxes(n);
      const pt: V3 = [0, 0, 0];
      pt[ua] = p.pos[ua] + h.u;
      pt[vb] = p.pos[vb] + h.v;
      pt[n] = s ? p.pos[n] + p.size[n] + 0.3 : p.pos[n] - 0.3;
      const m = new THREE.Mesh(holeGeo, h.depth > 0 && h.depth < p.size[n] ? holeBlind : holeThrough);
      m.scale.setScalar(h.dia / 2);
      m.position.set(...pt);
      if (n === 0) m.rotation.y = Math.PI / 2;
      else if (n === 1) m.rotation.x = Math.PI / 2;
      holeGroup.add(m);
    }
  }

  function rebuildEdges() {
    edgeGroup.clear();
    for (const p of data) {
      const t = thickAxis(p.size);
      for (let i = 0; i < 6; i++) {
        const a = i >> 1, side = i & 1;
        if (a === t || !p.edging[i]) continue;
        const size: V3 = [...p.size];
        const c: V3 = [p.pos[0] + p.size[0] / 2, p.pos[1] + p.size[1] / 2, p.pos[2] + p.size[2] / 2];
        const e = p.edge_mm; // prawdziwa grubość okleiny, pas leży na zewnątrz pomniejszonej płyty
        size[a] = e;
        c[a] = side ? p.pos[a] + p.size[a] + e / 2 : p.pos[a] - e / 2;
        const m = new THREE.Mesh(unitBox, edgeMat);
        m.scale.set(...size);
        m.position.set(...c);
        edgeGroup.add(m);
      }
    }
  }

  function paint() {
    for (const p of data) {
      const m = meshes.get(p.id)!;
      const mat = m.material as THREE.MeshStandardMaterial;
      const tex = p.texture ? getTexture(p.texture) : null;
      if (mat.map !== tex) { mat.map = tex; mat.needsUpdate = true; }
      mat.color.set(tex ? 0xffffff : p.color || COLOR_NORMAL);
      // zaznaczenie, grupa i przyciąganie jako poświata – nie psują koloru ani tekstury
      mat.emissive.set(sel.has(p.id) ? 0x6b5200 : guideIds.has(p.id) ? 0x14424f : p.group ? 0x26331a : 0x000000);
    }
  }

  function updateHandles() {
    const list = ids();
    const p = list.length === 1 ? data.find((q) => q.id === list[0]) : undefined;
    handles.visible = !!p;
    if (!p) return;
    for (const h of handles.children) {
      const { axis, side } = h.userData as { axis: number; side: number };
      h.position.set(p.pos[0] + p.size[0] / 2, p.pos[1] + p.size[1] / 2, p.pos[2] + p.size[2] / 2);
      h.position.setComponent(axis, p.pos[axis] + (side ? p.size[axis] : 0));
      h.visible = !(viewName !== 'persp' && axis === VIEW_AXIS[viewName]); // w 2D bez uchwytów "w głąb"
    }
  }

  function dropLines() {
    for (const l of [...guideLines.children]) {
      guideLines.remove(l);
      (l as THREE.Line).geometry.dispose();
    }
  }
  function clearGuides() {
    dropLines();
    guideIds = new Set();
    paint();
  }
  /** Podświetla płyty wyrównane z zaznaczeniem; dla środków rysuje linię łączącą środki. */
  function showGuides() {
    const b = selBox();
    dropLines();
    if (!b) { guideIds = new Set(); paint(); return; }
    const g: { id: number; axis: number; center: boolean }[] = JSON.parse(f.snap_guides(u32(), 5));
    guideIds = new Set(g.map((x) => x.id));
    const c = new THREE.Vector3((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
    for (const id of new Set(g.filter((x) => x.center).map((x) => x.id))) {
      const p = data.find((q) => q.id === id);
      if (!p) continue;
      const pc = new THREE.Vector3(p.pos[0] + p.size[0] / 2, p.pos[1] + p.size[1] / 2, p.pos[2] + p.size[2] / 2);
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([c, pc]),
        new THREE.LineBasicMaterial({ color: 0xff5ccd, depthTest: false }));
      line.renderOrder = 998;
      guideLines.add(line);
    }
    paint();
  }

  function placePivot() {
    updateHandles();
    const b = selBox();
    if (!b) { transform.detach(); return; }
    pivot.position.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
    if (!transform.object) transform.attach(pivot);
  }

  /** Ustawia zaznaczenie; płyty z tej samej grupy zawsze zaznaczają się razem. */
  function setSel(list: number[]) {
    const want = new Set(list);
    const groups = new Set(data.filter((p) => want.has(p.id) && p.group).map((p) => p.group));
    sel.clear();
    for (const p of data) if (want.has(p.id) || (p.group && groups.has(p.group))) sel.add(p.id);
    paint(); renderList(); syncForm(); placePivot();
  }

  function toggle(id: number) {
    const p = data.find((q) => q.id === id);
    if (!p) return;
    const members = p.group ? data.filter((q) => q.group === p.group).map((q) => q.id) : [id];
    const cur = new Set(ids());
    const on = cur.has(id);
    members.forEach((m) => (on ? cur.delete(m) : cur.add(m)));
    setSel([...cur]);
  }

  const additive = (e: MouseEvent | KeyboardEvent) => e.ctrlKey || e.shiftKey || e.metaKey;

  function renamePanel(id: number, current: string) {
    const n = prompt('Nazwa płyty (będzie widoczna w zestawieniu):', current);
    if (n !== null && n.trim()) act(() => f.rename(id, n.trim()));
  }

  function renderList() {
    const q = $<HTMLInputElement>('filter').value.trim().toLowerCase();
    $<HTMLUListElement>('list').replaceChildren(...data
      .filter((p) => !q || p.name.toLowerCase().includes(q))
      .map((p) => {
        const li = document.createElement('li');
        const name = document.createElement('b');
        name.textContent = p.name;
        const dims = document.createElement('span');
        dims.style.color = 'var(--muted)';
        dims.textContent = ` · ${p.size.map((n) => Math.round(n * 10) / 10).join('×')}${p.group ? ` · ▣ ${p.group}` : ''}`;
        li.append(name, dims);
        li.title = 'Dwuklik – zmień nazwę';
        if (sel.has(p.id)) li.className = 'sel';
        li.onclick = (e) => (additive(e) ? toggle(p.id) : setSel([p.id]));
        li.ondblclick = () => renamePanel(p.id, p.name);
        return li;
      }));
  }

  function syncHoles(p: PanelData, force = false) {
    if (!p.holes.some((h) => h.id === selHole)) selHole = p.holes[0]?.id ?? null;
    const hs = $<HTMLSelectElement>('holesel');
    hs.replaceChildren(...p.holes.map((h, k) => {
      const o = document.createElement('option');
      o.value = String(h.id);
      o.textContent = `${k + 1}. ${h.kind} Ø${h.dia}`;
      return o;
    }));
    hs.style.display = p.holes.length ? 'block' : 'none';
    const h = p.holes.find((x) => x.id === selHole);
    $('holefields').style.display = h ? 'block' : 'none';
    if (!h) return;
    hs.value = String(h.id);
    const AX = ['lewej (X−)', 'dołu (Y−)', 'tyłu (Z−)'];
    const [ua, vb] = faceAxes(h.face >> 1);
    ($('hul').firstChild as Text).data = `Od ${AX[ua]} (mm)`;
    ($('hvl').firstChild as Text).data = `Od ${AX[vb]} (mm)`;
    $<HTMLSelectElement>('hface').value = String(h.face);
    for (const [id, v] of [['hu', h.u], ['hv', h.v], ['hd', h.dia], ['hdepth', h.depth]] as const) {
      const el = $<HTMLInputElement>(id);
      if (force || document.activeElement !== el) el.value = String(Math.round(v * 100) / 100);
    }
  }

  function syncForm() {
    const list = ids();
    $('props').style.display = list.length ? 'block' : 'none';
    if (!list.length) return;
    $('count').textContent = list.length === 1 ? 'Zaznaczona płyta' : `Zaznaczono: ${list.length} płyt`;
    $('single').style.display = list.length === 1 ? 'block' : 'none';
    const set = (id: string, v: string | number) => {
      const el = $<HTMLInputElement>(id);
      if (document.activeElement !== el) el.value = String(v);
    };
    const b = selBox()!;
    set('px', b.min[0]); set('py', b.min[1]); set('pz', b.min[2]);
    const mms = new Set(data.filter((p) => sel.has(p.id)).map((p) => p.edge_mm));
    if (mms.size === 1) $<HTMLSelectElement>('edgemm').value = String([...mms][0]);
    const picked = data.filter((p) => sel.has(p.id));
    const same = <T>(fn: (p: PanelData) => T): T | undefined => { const s = new Set(picked.map(fn)); return s.size === 1 ? [...s][0] : undefined; };
    $<HTMLSelectElement>('texsel').value = same((p) => p.texture) ?? '';
    const ts = same((p) => p.tex_size);
    if (ts !== undefined && document.activeElement !== $('texsize')) $<HTMLInputElement>('texsize').value = String(ts);
    $<HTMLInputElement>('texrot').checked = same((p) => p.tex_rot) ?? false;
    const col = same((p) => p.color);
    if (col) $<HTMLInputElement>('pickcolor').value = col;
    if (list.length === 1) {
      const p = data.find((q) => q.id === list[0])!;
      set('name', p.name);
      set('sx', p.size[0]); set('sy', p.size[1]); set('sz', p.size[2]);
      const t = thickAxis(p.size);
      edgeBoxes.forEach(({ label, cb }, i) => {
        label.style.display = (i >> 1) === t ? 'none' : 'block'; // ścianki grubości nie są okleinowane
        cb.checked = !!p.edging[i];
      });
      $<HTMLSelectElement>('matsel').value = p.material;
      syncHoles(p);
    }
  }

  // --- akcje (używane przez przyciski i skróty) ---
  const single = () => (sel.size === 1 ? ids()[0] : null);

  function addPreset(key: string) {
    const [name, w, h, d] = PRESETS[key];
    let nid = 0;
    act(() => {
      nid = f.add_panel(name, w, h, d);
      const maxX = data.reduce((m, p) => Math.max(m, p.pos[0] + p.size[0]), 0);
      f.move_to(Uint32Array.of(nid), data.length ? maxX + 100 : 0, 0, 0, 0);
    });
    setSel([nid]);
  }
  function duplicate() {
    if (!sel.size) return;
    let copies: number[] = [];
    act(() => { copies = Array.from(f.duplicate(u32())); });
    setSel(copies);
  }
  const remove = () => { if (sel.size) act(() => f.remove_panels(u32())); };
  const group = () => { if (sel.size > 1) act(() => f.group(u32())); };
  const ungroup = () => { if (sel.size) act(() => f.ungroup(u32())); };
  const undo = () => { if (f.undo()) refresh(); };
  const redo = () => { if (f.redo()) refresh(); };
  function nudge(dx: number, dy: number, dz: number) {
    const b = selBox();
    if (b) act(() => f.move_to(u32(), b.min[0] + dx, b.min[1] + dy, b.min[2] + dz, 0));
  }

  // --- przyciski ---
  document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) => (b.onclick = () => addPreset(b.dataset.preset!)));
  document.querySelectorAll<HTMLButtonElement>('[data-rot]').forEach((b) => {
    b.onclick = () => {
      const id = single();
      if (id === null) return;
      const [a, c] = b.dataset.rot!.split(',').map(Number);
      act(() => f.swap_axes(id, a, c));
    };
  });
  $('undo').onclick = undo;
  $('redo').onclick = redo;
  $('dup').onclick = duplicate;
  $('del').onclick = remove;
  $('group').onclick = group;
  $('ungroup').onclick = ungroup;

  const EDGE_NAMES = ['lewa (X−)', 'prawa (X+)', 'dół (Y−)', 'góra (Y+)', 'tył (Z−)', 'przód (Z+)'];
  const edgeBoxes = EDGE_NAMES.map((name, i) => {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.onchange = () => {
      const id = single();
      if (id !== null) act(() => f.set_edge(id, i >> 1, i & 1, cb.checked, shrinkOn()));
    };
    label.append(cb, ' ' + name);
    $('edges').appendChild(label);
    return { label, cb };
  });
  // --- kolor i tekstura ---
  function renderPalette() {
    const custom = readCustomPalette();
    $('palette').replaceChildren(...[...PALETTE, ...custom].map((c, i) => {
      const b = document.createElement('button');
      b.style.background = c.hex;
      b.title = c.name + (i >= PALETTE.length ? ' (własny – prawy klik usuwa)' : '');
      b.onclick = () => { if (sel.size) act(() => f.set_color(u32(), c.hex)); };
      if (i >= PALETTE.length) {
        b.oncontextmenu = (e) => {
          e.preventDefault();
          if (confirm(`Usunąć kolor „${c.name}" z palety?`)) { removeCustomColor(c.hex); renderPalette(); }
        };
      }
      return b;
    }));
  }
  function fillTextureSelect(select?: string) {
    const s = $<HTMLSelectElement>('texsel');
    s.replaceChildren(...[''].concat(textureNames()).map((n) => {
      const o = document.createElement('option');
      o.value = n;
      o.textContent = n || '— brak —';
      return o;
    }));
    if (select !== undefined) s.value = select;
  }
  renderPalette();
  fillTextureSelect();
  $('pickcolor').addEventListener('change', () => {
    if (sel.size) act(() => f.set_color(u32(), $<HTMLInputElement>('pickcolor').value));
  });
  $('addcolor').onclick = () => {
    const name = prompt('Nazwa koloru w palecie:', 'Mój kolor');
    if (name) { addCustomColor(name, $<HTMLInputElement>('pickcolor').value); renderPalette(); }
  };
  $('nocolor').onclick = () => { if (sel.size) act(() => { f.set_color(u32(), ''); f.set_texture(u32(), ''); }); };
  $('texsel').addEventListener('change', () => {
    if (sel.size) act(() => f.set_texture(u32(), $<HTMLSelectElement>('texsel').value));
  });
  $('texup').onclick = () => $('texfile').click();
  $('texfile').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const name = prompt('Nazwa tekstury w bibliotece:', file.name.replace(/\.[^.]+$/, ''));
    if (!name) return;
    try {
      if (!addTexture(name, await imageToDataUrl(file))) { alert('Brak miejsca w pamięci przeglądarki. Usuń nieużywane tekstury.'); return; }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Nie udało się wczytać obrazu.');
      return;
    }
    fillTextureSelect(name);
    if (sel.size) act(() => f.set_texture(u32(), name));
  });
  $('texdel').onclick = () => {
    const name = $<HTMLSelectElement>('texsel').value;
    if (name && confirm(`Usunąć teksturę „${name}" z biblioteki? Płyty, które jej używają, wrócą do koloru domyślnego.`)) {
      removeTexture(name);
      fillTextureSelect('');
      refresh();
    }
  };
  for (const k of ['texsize', 'texrot']) $(k).addEventListener('change', () => {
    if (sel.size) act(() => f.set_tex_params(u32(), num('texsize'), $<HTMLInputElement>('texrot').checked));
  });

  // --- otwory i wiercenia ---
  EDGE_NAMES.forEach((n, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = n;
    $('hface').appendChild(o);
  });
  const selPanel = () => data.find((p) => sel.size === 1 && sel.has(p.id));
  type NewHole = { kind: string; face: number; u: number; v: number; dia: number; depth: number };
  function addHoles(list: NewHole[]) {
    const p = selPanel();
    if (!p || !list.length) return;
    let last = 0;
    act(() => { for (const h of list) last = f.add_hole(p.id, h.kind, h.face, h.u, h.v, h.dia, h.depth); });
    selHole = last;
    refresh();
  }
  /** Oś grubości, osie w płaszczyźnie i "wewnętrzna" ścianka (zwrócona do środka mebla). */
  function planeInfo(p: PanelData) {
    const t = thickAxis(p.size);
    const [a, b] = faceAxes(t);
    const box = allBox()!;
    const inner = p.pos[t] + p.size[t] / 2 < (box.min[t] + box.max[t]) / 2 ? 1 : 0;
    return { t, a, b, inner, innerFace: t * 2 + inner, outerFace: t * 2 + (1 - inner) };
  }
  const uv = (a: number, axis: number, along: number, across: number) => (a === axis ? { u: along, v: across } : { u: across, v: along });

  $('h-hole').onclick = () => {
    const p = selPanel();
    if (!p) return;
    const { a, b, innerFace } = planeInfo(p);
    addHoles([{ kind: 'Otwór', face: innerFace, u: p.size[a] / 2, v: p.size[b] / 2, dia: 5, depth: 0 }]);
  };
  $('h-hinge').onclick = () => {
    const p = selPanel();
    if (!p) return;
    const { t, a, b, innerFace } = planeInfo(p);
    const [L, S] = p.size[a] >= p.size[b] ? [a, b] : [b, a]; // oś długa i krótka
    const end = Math.min(100, p.size[L] / 4);
    const depth = Math.min(12.5, Math.max(1, p.size[t] - 3));
    addHoles([end, p.size[L] - end].map((l) => ({ kind: 'Zawias', face: innerFace, ...uv(a, L, l, 21.5), dia: 35, depth })));
    // 21,5 mm od krawędzi to odległość środka puszki dla typowego zawiasu (3–6 mm od krawędzi do puszki)
    void S;
  };
  $('h-shelf').onclick = () => {
    const p = selPanel();
    if (!p) return;
    const { t, a, b, innerFace } = planeInfo(p);
    if (t === 1) { alert('Rząd pod półki robi się na płycie pionowej (boku). Zaznacz bok mebla.'); return; }
    const dep = a === 1 ? b : a; // oś głębokości
    const out: NewHole[] = [];
    for (let h = 96; h <= p.size[1] - 96; h += 32) {
      for (const d of [37, p.size[dep] - 37]) out.push({ kind: 'Półka', face: innerFace, ...uv(a, 1, h, d), dia: 5, depth: Math.min(12, p.size[t] - 2) });
    }
    if (!out.length) { alert('Płyta jest za niska na rząd otworów co 32 mm.'); return; }
    addHoles(out);
  };
  $('h-handle').onclick = () => {
    const p = selPanel();
    if (!p) return;
    const raw = prompt('Rozstaw otworów uchwytu (mm), np. 96, 128 lub 160:', '128');
    const sp = Number((raw ?? '').replace(',', '.'));
    if (!(sp > 0)) return;
    const { a, b, outerFace } = planeInfo(p);
    const [L] = p.size[a] >= p.size[b] ? [a, b] : [b, a];
    const S = L === a ? b : a;
    const c = p.size[L] / 2, s = p.size[S] / 2;
    addHoles([c - sp / 2, c + sp / 2].map((l) => ({ kind: 'Uchwyt', face: outerFace, ...uv(a, L, l, s), dia: 5, depth: 0 })));
  };
  $('holesel').addEventListener('change', () => { selHole = Number($<HTMLSelectElement>('holesel').value); syncForm(); });
  for (const k of ['hface', 'hu', 'hv', 'hd', 'hdepth']) $(k).addEventListener('change', () => {
    const p = selPanel();
    if (!p || selHole === null) return;
    const hid = selHole;
    act(() => f.set_hole(p.id, hid, Number($<HTMLSelectElement>('hface').value), num('hu'), num('hv'), num('hd'), num('hdepth')));
    const p2 = selPanel();
    if (p2) syncHoles(p2, true);
  });
  $('hdel').onclick = () => {
    const p = selPanel();
    if (p && selHole !== null) { const hid = selHole; act(() => f.remove_hole(p.id, hid)); }
  };
  $('hdelall').onclick = () => {
    const p = selPanel();
    if (p && p.holes.length && confirm(`Usunąć wszystkie otwory (${p.holes.length}) z tej płyty?`)) act(() => { for (const h of p.holes) f.remove_hole(p.id, h.id); });
  };
  $('matsel').addEventListener('change', () => {
    if (sel.size) act(() => f.set_material(u32(), $<HTMLSelectElement>('matsel').value));
  });

  const shrinkOn = () => $<HTMLInputElement>('shrink').checked;
  $('edgeall').onclick = () => { if (sel.size) act(() => f.edge_preset(u32(), 1, shrinkOn())); };
  $('edgelong').onclick = () => { if (sel.size) act(() => f.edge_preset(u32(), 2, shrinkOn())); };
  $('edgenone').onclick = () => { if (sel.size) act(() => f.edge_preset(u32(), 0, shrinkOn())); };
  $('edgemm').addEventListener('change', () => {
    if (sel.size) act(() => f.set_edge_mm(u32(), Number($<HTMLSelectElement>('edgemm').value)));
  });

  $('name').addEventListener('change', () => {
    const id = single();
    if (id !== null) act(() => f.rename(id, $<HTMLInputElement>('name').value));
  });
  for (const k of ['sx', 'sy', 'sz']) $(k).addEventListener('change', () => {
    const id = single();
    if (id !== null) act(() => f.set_size(id, num('sx'), num('sy'), num('sz')));
  });
  for (const k of ['px', 'py', 'pz']) $(k).addEventListener('change', () => {
    if (sel.size) act(() => f.move_to(u32(), num('px'), num('py'), num('pz'), 0));
  });

  // --- przeciąganie strzałkami w scenie ---
  transform.addEventListener('dragging-changed', (e) => {
    orbit.enabled = !e.value;
    if (e.value) f.checkpoint(); // jedno cofnięcie na całe przeciągnięcie
    else clearGuides();
  });
  transform.addEventListener('objectChange', () => {
    const b = selBox();
    if (!b) return;
    f.move_to(u32(),
      pivot.position.x - (b.max[0] - b.min[0]) / 2,
      pivot.position.y - (b.max[1] - b.min[1]) / 2,
      pivot.position.z - (b.max[2] - b.min[2]) / 2, tol());
    refresh(); // Rust przyciągnął -> przestawia uchwyt na przyciągniętą pozycję
    showGuides();
  });

  // --- przeciąganie uchwytów: zmiana wymiaru jednej ścianki ---
  const hray = new THREE.Raycaster();
  const ndcOf = (e: PointerEvent) => {
    const r = renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  };
  // faza "capture": uchwyt ma pierwszeństwo przed strzałkami przesuwania i kamerą
  view.addEventListener('pointerdown', (e) => {
    const id = single();
    if (id === null || e.button !== 0 || (e.target as HTMLElement).closest('#views')) return;
    hray.setFromCamera(ndcOf(e), camera);
    const hit = hray.intersectObjects(handles.children.filter((h) => h.visible), false)[0];
    if (!hit) return;
    e.stopPropagation();
    const { axis, side } = hit.object.userData as { axis: number; side: number };
    // płaszczyzna zawierająca oś przeciągania i zwrócona do kamery
    const dir = new THREE.Vector3().setComponent(axis, 1);
    const cam = camera.getWorldDirection(new THREE.Vector3());
    const n = cam.clone().sub(dir.clone().multiplyScalar(cam.dot(dir)));
    if (n.lengthSq() < 1e-6) n.setComponent(axis === 1 ? 0 : 1, 1);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n.normalize(), hit.object.position);
    const start = new THREE.Vector3();
    if (!hray.ray.intersectPlane(plane, start)) return;
    const offset = hit.object.position.getComponent(axis) - start.getComponent(axis);
    down = null;
    orbit.enabled = false;
    transform.enabled = false;
    f.checkpoint(); // jedno cofnięcie na całe przeciągnięcie
    const move = (ev: PointerEvent) => {
      hray.setFromCamera(ndcOf(ev), camera);
      const q = new THREE.Vector3();
      if (!hray.ray.intersectPlane(plane, q)) return;
      f.resize_face(id, axis, side, q.getComponent(axis) + offset, tol());
      refresh();
      showGuides();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      orbit.enabled = true;
      transform.enabled = true;
      clearGuides();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, true);

  // --- zaznaczanie kliknięciem (nie po obracaniu kamery) ---
  const ray = new THREE.Raycaster();
  let down: { x: number; y: number } | null = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || transform.axis) return;
    const r = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects([...meshes.values()], false)[0];
    if (hit) { const id = hit.object.userData.id as number; additive(e) ? toggle(id) : setSel([id]); }
    else if (!additive(e)) setSel([]);
  });

  // --- skróty klawiaturowe ---
  window.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]')) return;
    const t = e.target as HTMLElement;
    if (t instanceof HTMLInputElement && (t.type === 'text' || t.type === 'number')) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const step = e.shiftKey ? 1 : 10;
    if (ctrl && k === 'z' && !e.shiftKey) undo();
    else if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) redo();
    else if (ctrl && k === 'a') setSel(data.map((p) => p.id));
    else if (ctrl && k === 'd') duplicate();
    else if (ctrl && k === 'g') (e.shiftKey ? ungroup : group)();
    else if (k === 'delete' || k === 'backspace') remove();
    else if (k === 'escape') setSel([]);
    else if (!ctrl && k === '0') setView('persp');
    else if (!ctrl && k === '1') setView('front');
    else if (!ctrl && k === '2') setView('side');
    else if (!ctrl && k === '3') setView('top');
    else if (k === 'arrowleft') nudge(-step, 0, 0);
    else if (k === 'arrowright') nudge(step, 0, 0);
    else if (k === 'arrowup') nudge(0, 0, -step);
    else if (k === 'arrowdown') nudge(0, 0, step);
    else if (k === 'pageup') nudge(0, step, 0);
    else if (k === 'pagedown') nudge(0, -step, 0);
    else return;
    e.preventDefault();
  });

  // --- eksport do AutoCAD: rzuty przód / bok / góra obok siebie (mm) ---
  $('dxf').onclick = () => {
    const b = allBox();
    if (!b) return;
    const gap = 200;
    const sideShift = b.max[0] + gap + b.max[2]; // widok z boku: poziomo = -Z
    const topShift = b.max[1] + gap + b.max[2];  // widok z góry: pionowo = -Z
    const lines: number[][] = [];
    for (const p of data) {
      lines.push(...rect(p.pos[0], p.pos[1], p.size[0], p.size[1]));                              // przód
      lines.push(...rect(sideShift - (p.pos[2] + p.size[2]), p.pos[1], p.size[2], p.size[1]));    // bok
      lines.push(...rect(p.pos[0], topShift - (p.pos[2] + p.size[2]), p.size[0], p.size[2]));     // góra
    }
    const texts = [
      { x: b.min[0], y: b.min[1] - 80, h: 40, s: 'Przod' },
      { x: sideShift - b.max[2], y: b.min[1] - 80, h: 40, s: 'Bok' },
      { x: b.min[0], y: topShift - b.min[2] + 40, h: 40, s: 'Gora' },
    ];
    downloadText('mebel.dxf', writeDxf([{ name: 'PLYTY', color: 7, lines, texts }]));
  };

  // --- biblioteka mebli (dla modułu mieszkania; ta sama przeglądarka) ---
  $('tolib').onclick = () => {
    const name = prompt('Nazwa mebla w bibliotece:', 'Szafka');
    if (!name) return;
    let lib: Record<string, string> = {};
    try { lib = JSON.parse(localStorage.getItem('meblarz:library') ?? '{}'); } catch { /* pusta */ }
    lib[name] = f.to_json();
    localStorage.setItem('meblarz:library', JSON.stringify(lib));
    alert('Zapisano w bibliotece. Znajdziesz go w module mieszkania.');
  };

  // --- zapis / odczyt ---
  $('save').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([packFurniture(f.to_json())], { type: 'application/json' }));
    a.download = 'mebel.json';
    a.click();
  };
  $('load').onclick = () => $('file').click();
  $('file').addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    f.checkpoint();
    let ok = false;
    try {
      const u = unpackFurniture(await file.text());
      let json = u.panelsJson;
      if (Object.keys(u.textures).length) {
        const r = importTextures(u.textures); // tekstury z pliku trafiają do biblioteki
        json = applyRenames(json, r.renames);
        fillTextureSelect();
        if (r.failed.length) alert(`Nie zmieściły się w pamięci przeglądarki tekstury: ${r.failed.join(', ')}. Usuń nieużywane tekstury i wczytaj plik ponownie.`);
      }
      ok = f.load_json(json);
    } catch { ok = false; }
    if (ok) { sel.clear(); refresh(); } else alert('Nieprawidłowy plik');
  });

  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => {
    b.onclick = () => setView(b.dataset.view as ViewName);
  });

  // --- zestawienie płyt ---
  const dlg = $<HTMLDialogElement>('cut');
  let csv = '';
  $('cutbtn').onclick = () => {
    const rows: { decor: string; name: string; length: number; width: number; thickness: number; qty: number; edge_l: number; edge_w: number; edge_mm: number; final_length: number; final_width: number }[] = JSON.parse(f.cut_list());
    const tbody = $('cutbody');
    tbody.replaceChildren();
    const lines = ['Lp.;Nazwa;Dekor;Długość [mm];Szerokość [mm];Grubość [mm];Ilość;Gotowy wymiar z okleiną [mm];Okleina wzdłuż dł. [szt];Okleina wzdłuż szer. [szt];Grubość okleiny [mm]'];
    const edgeBy = new Map<number, number>(); // grubość okleiny -> łączna długość w mm
    const area = new Map<number, number>();
    let total = 0;
    rows.forEach((r, i) => {
      total += r.qty;
      if (r.edge_mm) edgeBy.set(r.edge_mm, (edgeBy.get(r.edge_mm) ?? 0) + r.qty * (r.edge_l * r.length + r.edge_w * r.width));
      area.set(r.thickness, (area.get(r.thickness) ?? 0) + (r.length * r.width * r.qty) / 1e6);
      const decorLabel = !r.decor ? '—' : r.decor.startsWith('#') ? colorName(r.decor) : r.decor;
      const base = [i + 1, r.name, decorLabel, r.length, r.width, r.thickness, r.qty].map(String);
      const fin = `${Math.round(r.final_length * 10) / 10} × ${Math.round(r.final_width * 10) / 10}`;
      const edgeText = ([r.edge_l ? `${r.edge_l}× dł.` : '', r.edge_w ? `${r.edge_w}× szer.` : ''].filter(Boolean).join(' + ') || '—') + (r.edge_mm ? ` (${r.edge_mm} mm)` : '');
      const cells = [...base, fin, edgeText];
      const tr = document.createElement('tr');
      for (const c of cells) { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); }
      tbody.appendChild(tr);
      lines.push([...base, fin, String(r.edge_l), String(r.edge_w), String(r.edge_mm || '')].map((c) => `"${c.replace(/"/g, '""')}"`).join(';'));
    });
    csv = '\ufeff' + lines.join('\r\n'); // BOM, żeby Excel poprawnie pokazał polskie znaki
    $('cutsum').textContent = rows.length
      ? `Razem: ${total} płyt · ` + [...area].map(([t, a]) => `${t} mm: ${a.toFixed(2)} m²`).join(' · ') + ` · okleina: ${edgeBy.size ? [...edgeBy].map(([mm, len]) => `${mm} mm: ${(len / 1000).toFixed(2)} m`).join(', ') : 'brak'}`
      : 'Brak płyt.';
    dlg.showModal();
  };
  $('cutclose').onclick = () => dlg.close();
  $('cutcopy').onclick = () => navigator.clipboard.writeText(csv.replace('\ufeff', ''));
  $('cutcsv').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'zestawienie_plyt.csv';
    a.click();
  };

  // --- masa i nośność ---
  const MAT_NAMES: Record<string, string> = { chipboard: 'Płyta wiórowa', mdf: 'MDF', hdf: 'HDF', plywood: 'Sklejka', pine: 'Drewno sosnowe' };
  const trOf = (cells: (string | HTMLElement)[]) => {
    const tr = document.createElement('tr');
    for (const c of cells) {
      const td = document.createElement('td');
      if (typeof c === 'string') td.textContent = c; else td.appendChild(c);
      tr.appendChild(td);
    }
    return tr;
  };
  const massDlg = $<HTMLDialogElement>('mass');
  let matOf = new Map<number, string>();

  function fillShelves() {
    const ratio = Number($<HTMLSelectElement>('defl').value);
    const body = $('shelfbody');
    body.replaceChildren();
    const shelves = data.filter((p) => thickAxis(p.size) === 1 && p.size[1] > 4); // płyty poziome
    if (!shelves.length) { body.appendChild(trOf(['Brak poziomych płyt (półek) w meblu.', '', '', '', ''])); return; }
    for (const p of shelves) {
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '50';
      input.value = String(Math.max(p.size[0], p.size[2]));
      input.style.width = '90px';
      const cs = document.createElement('span'), cl = document.createElement('span');
      const calc = () => {
        const r = JSON.parse(f.shelf_capacity(p.id, Number(input.value), ratio));
        cs.textContent = `${r.allow_short_kg.toFixed(1)} kg`;
        cl.textContent = `${r.allow_long_kg.toFixed(1)} kg`;
      };
      input.addEventListener('input', calc);
      calc();
      body.appendChild(trOf([p.name, `${MAT_NAMES[matOf.get(p.id) ?? ''] ?? '?'} · ${Math.round(p.size[1] * 10) / 10} mm`, input, cs, cl]));
    }
  }
  $('defl').addEventListener('change', fillShelves);
  $('massbtn').onclick = () => {
    const rep = JSON.parse(f.mass_report());
    matOf = new Map(rep.rows.map((r: { id: number; material: string }) => [r.id, r.material]));
    const body = $('massbody');
    body.replaceChildren(...rep.rows.map((r: { name: string; material: string; mass_kg: number }) => trOf([r.name, MAT_NAMES[r.material] ?? r.material, r.mass_kg.toFixed(2)])));
    const rel = (i: number) => Math.round(rep.cog[i] - rep.bbox_min[i]);
    $('masssum').textContent = rep.rows.length
      ? `Razem: ${rep.total_kg.toFixed(1)} kg (płyty ${rep.panels_kg.toFixed(1)} kg + okleina ${rep.edging_kg.toFixed(2)} kg, bez okuć). ` +
        `Środek ciężkości: ${rel(0)} mm od lewej, ${rel(1)} mm od dołu, ${rel(2)} mm od tyłu (liczone od krawędzi mebla).`
      : 'Brak płyt.';
    fillShelves();
    massDlg.showModal();
  };
  $('massclose').onclick = () => massDlg.close();

  // --- lista wierceń ---
  const drillDlg = $<HTMLDialogElement>('drill');
  let drillCsv = '';
  $('drillbtn').onclick = () => {
    const AX = ['lewej', 'dołu', 'tyłu'];
    const body = $('drillbody');
    body.replaceChildren();
    const lines = ['Płyta;Rodzaj;Strona;Położenie 1 [mm];Położenie 2 [mm];Średnica [mm];Głębokość [mm]'];
    const list = data.flatMap((p) => p.holes.map((h) => ({ p, h }))).sort((x, y) => x.p.name.localeCompare(y.p.name) || x.h.dia - y.h.dia);
    for (const { p, h } of list) {
      const n = h.face >> 1;
      const [ua, vb] = faceAxes(n);
      const depth = h.depth > 0 && h.depth < p.size[n] ? String(h.depth) : 'na wylot';
      const pos = `od ${AX[ua]}: ${Math.round(h.u * 10) / 10} · od ${AX[vb]}: ${Math.round(h.v * 10) / 10}`;
      body.appendChild(trOf([p.name, h.kind, EDGE_NAMES[h.face], pos, String(h.dia), depth]));
      lines.push([p.name, h.kind, EDGE_NAMES[h.face], String(Math.round(h.u * 10) / 10), String(Math.round(h.v * 10) / 10), String(h.dia), depth]
        .map((c) => `"${c.replace(/"/g, '""')}"`).join(';'));
    }
    drillCsv = '\ufeff' + lines.join('\r\n');
    $('drillsum').textContent = list.length ? `Razem otworów: ${list.length}.` : 'Brak otworów. Dodaj je w sekcji „Otwory i wiercenia" po zaznaczeniu płyty.';
    drillDlg.showModal();
  };
  $('drillclose').onclick = () => drillDlg.close();
  $('drillcsv').onclick = () => downloadText('lista_wiercen.csv', drillCsv, 'text/csv;charset=utf-8');

  // przykładowy start: 2 boki + dno
  for (const [key, x] of [['bok', 0], ['bok', 782], ['poziom', 18]] as const) {
    const [name, w, h, d] = PRESETS[key];
    f.move_to(Uint32Array.of(f.add_panel(name, w, h, d)), x, 0, 0, 0);
  }
  refresh();
}

main();
