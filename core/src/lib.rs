//! Rdzeń projektowania mebli. Wszystkie wymiary w milimetrach.
//! Osie: X = szerokość, Y = wysokość (góra), Z = głębokość.
//! Płyta to prostopadłościan równoległy do osi: `pos` = narożnik min, `size` = [X, Y, Z].

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

pub mod apartment;

#[derive(Serialize, Deserialize, Clone, PartialEq)]
pub struct Panel {
    pub id: u32,
    pub name: String,
    pub size: [f64; 3],
    pub pos: [f64; 3],
    /// 0 = bez grupy
    #[serde(default)]
    pub group: u32,
    /// Okleina na wąskich ściankach: indeks = oś*2 + strona (0 = min, 1 = max).
    /// Ścianki prostopadłe do osi grubości są ignorowane.
    #[serde(default)]
    pub edging: [bool; 6],
    /// Grubość okleiny tej płyty w mm: 0,8 albo 2.
    #[serde(default = "default_edge_mm")]
    pub edge_mm: f64,
    /// O ile mm dana ścianka została pomniejszona z powodu okleiny (0 = wcale).
    /// Dzięki temu po zdjęciu okleiny płyta wraca do poprzedniego wymiaru.
    #[serde(default)]
    pub inset: [f64; 6],
    /// Klucz materiału ("chipboard", "mdf", "hdf", "plywood", "pine"); pusty = automatycznie wg grubości.
    #[serde(default)]
    pub material: String,
    #[serde(default)]
    pub holes: Vec<Hole>,
    /// Kolor "#rrggbb" ("" = domyślny). Kolor i tekstura wykluczają się.
    #[serde(default)]
    pub color: String,
    /// Nazwa tekstury z biblioteki w przeglądarce ("" = brak).
    #[serde(default)]
    pub texture: String,
    /// Ile mm to jedno powtórzenie tekstury.
    #[serde(default = "default_tex_size")]
    pub tex_size: f64,
    /// Usłojenie obrócone o 90°.
    #[serde(default)]
    pub tex_rot: bool,
}

fn default_tex_size() -> f64 {
    600.0
}

fn valid_hex(c: &str) -> bool {
    c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit())
}

/// Otwór / wiercenie. `face` = oś*2 + strona (0 = min, 1 = max) ścianki, w której jest otwór.
/// (u, v) = środek otworu na tej ściance, mierzony od jej krawędzi min na osiach z `face_axes`.
/// `depth` 0 = na wylot.
#[derive(Serialize, Deserialize, Clone, PartialEq)]
pub struct Hole {
    pub id: u32,
    pub kind: String,
    pub face: u8,
    pub u: f64,
    pub v: f64,
    pub dia: f64,
    pub depth: f64,
}

/// Osie leżące w płaszczyźnie ścianki o normalnej na osi `n` (rosnąco).
fn face_axes(n: usize) -> (usize, usize) {
    match n {
        0 => (1, 2),
        1 => (0, 2),
        _ => (0, 1),
    }
}

fn clamp_hole(size: [f64; 3], h: &mut Hole, face: u8, u: f64, v: f64, dia: f64, depth: f64) {
    let face = face.min(5);
    let n = (face / 2) as usize;
    let (ua, vb) = face_axes(n);
    h.face = face;
    h.dia = dia.max(1.0);
    h.u = u.max(0.0).min(size[ua]);
    h.v = v.max(0.0).min(size[vb]);
    h.depth = if depth <= 0.0 || depth >= size[n] { 0.0 } else { depth };
}

/// Zamiana osi a<->b: otwory jadą razem z płytą.
fn swap_holes(p: &mut Panel, a: usize, b: usize, old_size: [f64; 3]) {
    for h in &mut p.holes {
        let n = (h.face / 2) as usize;
        let s = (h.face % 2) as usize;
        let (ua, vb) = face_axes(n);
        let mut pt = [0.0; 3];
        pt[n] = if s == 1 { old_size[n] } else { 0.0 };
        pt[ua] = h.u;
        pt[vb] = h.v;
        pt.swap(a, b);
        let n2 = if n == a { b } else if n == b { a } else { n };
        let (ua2, vb2) = face_axes(n2);
        h.face = (n2 * 2 + s) as u8;
        h.u = pt[ua2];
        h.v = pt[vb2];
    }
}

/// Narożnik min płyty przesunął się o `delta` na osi `axis` – otwory zostają na swoim miejscu w świecie.
fn shift_holes(p: &mut Panel, axis: usize, delta: f64) {
    for h in &mut p.holes {
        let n = (h.face / 2) as usize;
        if n == axis {
            continue;
        }
        let (ua, vb) = face_axes(n);
        if ua == axis {
            h.u -= delta;
        } else if vb == axis {
            h.v -= delta;
        }
    }
}

/// Materiały: gęstość [kg/m³], moduł sprężystości E [MPa], wytrzymałość na zginanie fm [MPa],
/// współczynnik pełzania k_def. Wartości przybliżone/typowe – do orientacji, nie do certyfikacji.
struct Mat {
    key: &'static str,
    density: f64,
    e: f64,
    fm: f64,
    kdef: f64,
}
static MATS: [Mat; 5] = [
    Mat { key: "chipboard", density: 680.0, e: 1800.0, fm: 11.0, kdef: 2.25 },
    Mat { key: "mdf", density: 750.0, e: 2500.0, fm: 20.0, kdef: 2.25 },
    Mat { key: "hdf", density: 900.0, e: 3000.0, fm: 30.0, kdef: 2.25 },
    Mat { key: "plywood", density: 680.0, e: 5000.0, fm: 25.0, kdef: 0.8 },
    Mat { key: "pine", density: 500.0, e: 11000.0, fm: 24.0, kdef: 0.6 },
];

fn mat_for(p: &Panel) -> &'static Mat {
    let key = if p.material.is_empty() {
        if p.size.iter().cloned().fold(f64::MAX, f64::min) <= 4.0 { "hdf" } else { "chipboard" }
    } else {
        p.material.as_str()
    };
    MATS.iter().find(|m| m.key == key).unwrap_or(&MATS[0])
}

fn hole_volume(p: &Panel, h: &Hole) -> f64 {
    let n = ((h.face / 2) as usize).min(2);
    let depth = if h.depth <= 0.0 || h.depth >= p.size[n] { p.size[n] } else { h.depth };
    std::f64::consts::PI * (h.dia / 2.0).powi(2) * depth
}

fn panel_mass_kg(p: &Panel) -> f64 {
    let vol = p.size[0] * p.size[1] * p.size[2] - p.holes.iter().map(|h| hole_volume(p, h)).sum::<f64>();
    vol.max(0.0) * 1e-9 * mat_for(p).density
}

/// Masa okleiny PVC (gęstość 1400 kg/m³).
fn edging_mass_kg(p: &Panel) -> f64 {
    let ax = axes_by_size(&p.size);
    let t = ax[2];
    let mut vol = 0.0;
    for i in 0..6 {
        let axis = i / 2;
        if !p.edging[i] || axis == t {
            continue;
        }
        let other = if axis == ax[0] { ax[1] } else { ax[0] };
        vol += p.size[other] * p.size[t] * p.edge_mm;
    }
    vol * 1e-9 * 1400.0
}

#[derive(Serialize)]
struct MassRow {
    id: u32,
    name: String,
    material: String,
    mass_kg: f64,
    holes: usize,
}

#[derive(Serialize)]
struct MassReport {
    rows: Vec<MassRow>,
    panels_kg: f64,
    edging_kg: f64,
    total_kg: f64,
    cog: [f64; 3],
    bbox_min: [f64; 3],
    bbox_max: [f64; 3],
}

fn default_edge_mm() -> f64 {
    0.8
}

/// Ustawia, o ile ścianka `i` jest cofnięta do wewnątrz (pomniejszenie płyty o okleinę).
fn apply_inset(p: &mut Panel, i: usize, target: f64) {
    let delta = target - p.inset[i];
    if delta.abs() < 1e-9 {
        return;
    }
    let (axis, side) = (i / 2, i % 2);
    if p.size[axis] - delta < 1.0 {
        return; // płyta byłaby mniejsza niż 1 mm
    }
    if side == 0 {
        p.pos[axis] += delta; // ścianka min cofa się do środka
        shift_holes(p, axis, delta);
    }
    p.size[axis] -= delta;
    p.inset[i] = target;
}

/// Włącza/wyłącza okleinę na ściance `i`. Przy `inset` płyta jest pomniejszana o grubość okleiny.
fn set_edge_on(p: &mut Panel, i: usize, on: bool, inset: bool) {
    p.edging[i] = on;
    apply_inset(p, i, if on && inset { p.edge_mm } else { 0.0 });
}

/// Osie posortowane od najdłuższej do najcieńszej (przy remisie: wg numeru osi).
/// [0] = oś długości, [1] = oś szerokości, [2] = oś grubości.
fn axes_by_size(s: &[f64; 3]) -> [usize; 3] {
    let mut ax = [0usize, 1, 2];
    ax.sort_by(|&i, &j| s[j].total_cmp(&s[i]));
    ax
}

#[wasm_bindgen]
pub struct Furniture {
    panels: Vec<Panel>,
    next_id: u32,
    next_group: u32,
    undo_stack: Vec<Vec<Panel>>,
    redo_stack: Vec<Vec<Panel>>,
}

impl Furniture {
    fn find(&self, id: u32) -> Option<usize> {
        self.panels.iter().position(|p| p.id == id)
    }

    /// Prostopadłościan otaczający wskazane płyty: (min, max).
    fn bbox(&self, ids: &[u32]) -> Option<([f64; 3], [f64; 3])> {
        let mut min = [f64::MAX; 3];
        let mut max = [f64::MIN; 3];
        let mut any = false;
        for p in self.panels.iter().filter(|p| ids.contains(&p.id)) {
            any = true;
            for a in 0..3 {
                min[a] = min[a].min(p.pos[a]);
                max[a] = max[a].max(p.pos[a] + p.size[a]);
            }
        }
        any.then_some((min, max))
    }

    /// Przyciąga krawędzie zaznaczenia na osi `a` do krawędzi innych płyt.
    /// Bierze pod uwagę tylko płyty, które są w pobliżu na pozostałych osiach.
    fn snap_axis(&self, ids: &[u32], a: usize, want: [f64; 3], size: [f64; 3], tol: f64) -> f64 {
        let mut best: Option<f64> = None;
        for p in self.panels.iter().filter(|p| !ids.contains(&p.id)) {
            let near = (0..3).filter(|&b| b != a).all(|b| {
                want[b] <= p.pos[b] + p.size[b] + tol && want[b] + size[b] >= p.pos[b] - tol
            });
            if !near {
                continue;
            }
            let (omin, omax) = (p.pos[a], p.pos[a] + p.size[a]);
            let (lo, hi) = (want[a], want[a] + size[a]);
            // krawędzie do krawędzi + środek zaznaczenia do środka sąsiedniej płyty
            let mid = ((lo + hi) / 2.0, (omin + omax) / 2.0);
            for (mine, target) in [(lo, omin), (lo, omax), (hi, omin), (hi, omax), mid] {
                let d = target - mine;
                if d.abs() <= tol && best.map_or(true, |b| d.abs() < b.abs()) {
                    best = Some(d);
                }
            }
        }
        want[a] + best.unwrap_or(0.0)
    }

    /// Przyciąga pojedynczą współrzędną (ściankę) do krawędzi sąsiednich płyt.
    fn snap_value(&self, id: u32, a: usize, v: f64, pos: [f64; 3], size: [f64; 3], tol: f64) -> f64 {
        let mut best: Option<f64> = None;
        for p in self.panels.iter().filter(|p| p.id != id) {
            let near = (0..3).filter(|&b| b != a).all(|b| {
                pos[b] <= p.pos[b] + p.size[b] + tol && pos[b] + size[b] >= p.pos[b] - tol
            });
            if !near {
                continue;
            }
            for target in [p.pos[a], p.pos[a] + p.size[a]] {
                let d = target - v;
                if d.abs() <= tol && best.map_or(true, |b| d.abs() < b.abs()) {
                    best = Some(d);
                }
            }
        }
        v + best.unwrap_or(0.0)
    }
}

#[derive(Serialize)]
struct Guide {
    id: u32,
    axis: usize,
    center: bool,
}

#[derive(Serialize)]
struct CutRow {
    name: String,
    decor: String, // nazwa tekstury albo kolor #rrggbb ("" = domyślny)
    edge_l: u32,   // ile krawędzi biegnących wzdłuż długości jest oklejonych (0-2)
    edge_w: u32,   // ile krawędzi biegnących wzdłuż szerokości jest oklejonych (0-2)
    edge_mm: f64,  // grubość okleiny (0 gdy brak)
    final_length: f64, // wymiar gotowy: formatka + okleina
    final_width: f64,
    length: f64,
    width: f64,
    thickness: f64,
    qty: u32,
}

#[wasm_bindgen]
impl Furniture {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Furniture {
        Furniture { panels: vec![], next_id: 1, next_group: 1, undo_stack: vec![], redo_stack: vec![] }
    }

    // ---------- cofnij / ponów (zapis całego stanu, mebel jest mały) ----------

    /// Wołaj tuż PRZED każdą zmianą wykonywaną przez użytkownika.
    pub fn checkpoint(&mut self) {
        self.undo_stack.push(self.panels.clone());
        if self.undo_stack.len() > 200 {
            self.undo_stack.remove(0);
        }
        self.redo_stack.clear();
    }

    pub fn undo(&mut self) -> bool {
        while let Some(prev) = self.undo_stack.pop() {
            if prev != self.panels {
                self.redo_stack.push(std::mem::replace(&mut self.panels, prev));
                return true;
            }
        }
        false
    }

    pub fn redo(&mut self) -> bool {
        while let Some(next) = self.redo_stack.pop() {
            if next != self.panels {
                self.undo_stack.push(std::mem::replace(&mut self.panels, next));
                return true;
            }
        }
        false
    }

    // ---------- płyty ----------

    pub fn add_panel(&mut self, name: &str, w: f64, h: f64, d: f64) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        self.panels.push(Panel {
            id,
            name: name.to_string(),
            size: [w.max(1.0), h.max(1.0), d.max(1.0)],
            pos: [0.0; 3],
            group: 0,
            edging: [false; 6],
            edge_mm: 0.8,
            inset: [0.0; 6],
            material: String::new(),
            holes: vec![],
            color: String::new(),
            texture: String::new(),
            tex_size: 600.0,
            tex_rot: false,
        });
        id
    }

    pub fn remove_panels(&mut self, ids: &[u32]) {
        self.panels.retain(|p| !ids.contains(&p.id));
    }

    pub fn rename(&mut self, id: u32, name: &str) {
        if let Some(i) = self.find(id) {
            self.panels[i].name = name.to_string();
        }
    }

    pub fn set_size(&mut self, id: u32, w: f64, h: f64, d: f64) {
        if let Some(i) = self.find(id) {
            self.panels[i].size = [w.max(1.0), h.max(1.0), d.max(1.0)];
        }
    }

    /// Obrót o 90° = zamiana dwóch wymiarów (0=X, 1=Y, 2=Z).
    pub fn swap_axes(&mut self, id: u32, a: usize, b: usize) {
        if a < 3 && b < 3 {
            if let Some(i) = self.find(id) {
                let old = self.panels[i].size;
                self.panels[i].size.swap(a, b);
                swap_holes(&mut self.panels[i], a, b, old);
                for s in 0..2 {
                    self.panels[i].edging.swap(a * 2 + s, b * 2 + s); // okleina obraca się razem z płytą
                    self.panels[i].inset.swap(a * 2 + s, b * 2 + s);
                }
            }
        }
    }

    /// Przesuwa zaznaczenie tak, by jego narożnik min trafił w (x,y,z).
    /// `tol` > 0 włącza przyciąganie (mm).
    pub fn move_to(&mut self, ids: &[u32], x: f64, y: f64, z: f64, tol: f64) {
        let Some((min, max)) = self.bbox(ids) else { return };
        let size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
        let want = [x.round(), y.round(), z.round()];
        let mut out = want;
        if tol > 0.0 {
            for a in 0..3 {
                out[a] = self.snap_axis(ids, a, want, size, tol);
            }
        }
        let d = [out[0] - min[0], out[1] - min[1], out[2] - min[2]];
        for p in self.panels.iter_mut().filter(|p| ids.contains(&p.id)) {
            for a in 0..3 {
                p.pos[a] += d[a];
            }
        }
    }

    /// Duplikuje zaznaczenie (grupy też, jako nowe grupy). Zwraca id kopii.
    pub fn duplicate(&mut self, ids: &[u32]) -> Vec<u32> {
        let Some((min, max)) = self.bbox(ids) else { return vec![] };
        let dx = max[0] - min[0] + 50.0;
        let src: Vec<Panel> = self.panels.iter().filter(|p| ids.contains(&p.id)).cloned().collect();
        let mut group_map: Vec<(u32, u32)> = vec![];
        let mut out = vec![];
        for mut p in src {
            p.id = self.next_id;
            self.next_id += 1;
            p.pos[0] += dx;
            if p.group != 0 {
                p.group = match group_map.iter().find(|(old, _)| *old == p.group) {
                    Some((_, new)) => *new,
                    None => {
                        let new = self.next_group;
                        self.next_group += 1;
                        group_map.push((p.group, new));
                        new
                    }
                };
            }
            out.push(p.id);
            self.panels.push(p);
        }
        out
    }

    /// Włącza/wyłącza okleinę na jednej ściance. `inset` = pomniejsz płytę o grubość okleiny.
    pub fn set_edge(&mut self, id: u32, axis: usize, side: usize, on: bool, inset: bool) {
        if axis < 3 && side < 2 {
            if let Some(i) = self.find(id) {
                set_edge_on(&mut self.panels[i], axis * 2 + side, on, inset);
            }
        }
    }

    /// 0 = zdejmij okleinę, 1 = wszystkie 4 krawędzie, 2 = tylko długie krawędzie.
    pub fn edge_preset(&mut self, ids: &[u32], mode: u32, inset: bool) {
        for p in self.panels.iter_mut().filter(|p| ids.contains(&p.id)) {
            let ax = axes_by_size(&p.size);
            let mut want = [false; 6];
            if mode != 0 {
                for k in 0..2 {
                    // ścianki na osi szerokości (k=1) mają długie krawędzie
                    let long = k == 1 || p.size[ax[0]] == p.size[ax[1]];
                    if mode == 1 || long {
                        want[ax[k] * 2] = true;
                        want[ax[k] * 2 + 1] = true;
                    }
                }
            }
            for i in 0..6 {
                set_edge_on(p, i, want[i], inset);
            }
        }
    }

    /// Grubość okleiny: 0,8 albo 2 mm. Już pomniejszone ścianki dostosowują się do nowej grubości.
    pub fn set_edge_mm(&mut self, ids: &[u32], mm: f64) {
        let mm = if mm >= 1.4 { 2.0 } else { 0.8 };
        for p in self.panels.iter_mut().filter(|p| ids.contains(&p.id)) {
            p.edge_mm = mm;
            for i in 0..6 {
                if p.inset[i] > 0.0 {
                    apply_inset(p, i, mm);
                }
            }
        }
    }

    /// Przesuwa jedną ściankę płyty (oś 0/1/2, strona 0 = min, 1 = max); przeciwna zostaje.
    pub fn resize_face(&mut self, id: u32, axis: usize, side: u32, value: f64, tol: f64) {
        if axis > 2 {
            return;
        }
        let Some(i) = self.find(id) else { return };
        let (pos, size) = (self.panels[i].pos, self.panels[i].size);
        let mut v = value.round();
        if tol > 0.0 {
            v = self.snap_value(id, axis, v, pos, size, tol);
        }
        let (lo, hi) = (pos[axis], pos[axis] + size[axis]);
        let p = &mut self.panels[i];
        if side == 1 {
            p.size[axis] = v.max(lo + 1.0) - lo;
        } else {
            let new_lo = v.min(hi - 1.0);
            shift_holes(p, axis, new_lo - lo);
            p.pos[axis] = new_lo;
            p.size[axis] = hi - new_lo;
        }
    }

    /// Zestawienie płyt: ta sama nazwa + te same wymiary + ta sama okleina = jeden wiersz z ilością (JSON).
    /// Długość = największy wymiar formatki, grubość = najmniejszy.
    pub fn cut_list(&self) -> String {
        let mut rows: Vec<CutRow> = vec![];
        for p in &self.panels {
            let ax = axes_by_size(&p.size);
            let (length, width, thickness) = (p.size[ax[0]], p.size[ax[1]], p.size[ax[2]]);
            let cnt = |axis: usize| p.edging[axis * 2] as u32 + p.edging[axis * 2 + 1] as u32;
            // ścianki na osi szerokości mają krawędzie biegnące wzdłuż długości i odwrotnie
            let (edge_l, edge_w) = (cnt(ax[1]), cnt(ax[0]));
            let edge_mm = if edge_l + edge_w > 0 { p.edge_mm } else { 0.0 };
            let fin = |axis: usize| p.size[axis] + p.inset[axis * 2] + p.inset[axis * 2 + 1];
            let (final_length, final_width) = (fin(ax[0]), fin(ax[1]));
            let decor = if p.texture.is_empty() { p.color.clone() } else { p.texture.clone() };
            match rows.iter_mut().find(|r| {
                r.name == p.name && r.decor == decor && r.length == length && r.width == width && r.thickness == thickness
                    && r.edge_l == edge_l && r.edge_w == edge_w && r.edge_mm == edge_mm
                    && r.final_length == final_length && r.final_width == final_width
            }) {
                Some(r) => r.qty += 1,
                None => rows.push(CutRow {
                    name: p.name.clone(),
                    decor: decor.clone(),
                    edge_l,
                    edge_w,
                    edge_mm,
                    final_length,
                    final_width,
                    length,
                    width,
                    thickness,
                    qty: 1,
                }),
            }
        }
        rows.sort_by(|a, b| {
            b.thickness.total_cmp(&a.thickness)
                .then(a.name.cmp(&b.name))
                .then(b.length.total_cmp(&a.length))
                .then(b.width.total_cmp(&a.width))
        });
        serde_json::to_string(&rows).unwrap_or_else(|_| "[]".into())
    }

    // ---------- otwory i wiercenia ----------

    /// Dodaje otwór; zwraca jego id (0 = brak takiej płyty). depth = 0 oznacza otwór na wylot.
    pub fn add_hole(&mut self, panel_id: u32, kind: &str, face: u8, u: f64, v: f64, dia: f64, depth: f64) -> u32 {
        let Some(i) = self.find(panel_id) else { return 0 };
        let id = self.next_id;
        self.next_id += 1;
        let mut h = Hole { id, kind: kind.to_string(), face: 0, u: 0.0, v: 0.0, dia: 5.0, depth: 0.0 };
        clamp_hole(self.panels[i].size, &mut h, face, u, v, dia, depth);
        self.panels[i].holes.push(h);
        id
    }

    pub fn set_hole(&mut self, panel_id: u32, hole_id: u32, face: u8, u: f64, v: f64, dia: f64, depth: f64) {
        let Some(i) = self.find(panel_id) else { return };
        let size = self.panels[i].size;
        if let Some(h) = self.panels[i].holes.iter_mut().find(|h| h.id == hole_id) {
            clamp_hole(size, h, face, u, v, dia, depth);
        }
    }

    pub fn remove_hole(&mut self, panel_id: u32, hole_id: u32) {
        if let Some(i) = self.find(panel_id) {
            self.panels[i].holes.retain(|h| h.id != hole_id);
        }
    }

    // ---------- materiał, masa, nośność ----------

    // ---------- kolor i tekstura ----------

    /// Kolor "#rrggbb" albo "" (domyślny). Ustawienie koloru zdejmuje teksturę.
    pub fn set_color(&mut self, ids: &[u32], color: &str) {
        if !color.is_empty() && !valid_hex(color) {
            return;
        }
        for p in self.panels.iter_mut().filter(|p| ids.contains(&p.id)) {
            p.color = color.to_lowercase();
            if !color.is_empty() {
                p.texture.clear();
            }
        }
    }

    /// Nazwa tekstury z biblioteki albo "" (brak). Ustawienie tekstury zdejmuje kolor.
    pub fn set_texture(&mut self, ids: &[u32], name: &str) {
        for p in self.panels.iter_mut().filter(|p| ids.contains(&p.id)) {
            p.texture = name.to_string();
            if !name.is_empty() {
                p.color.clear();
            }
        }
    }

    /// Rozmiar jednego powtórzenia tekstury (mm) i obrót usłojenia o 90°.
    pub fn set_tex_params(&mut self, ids: &[u32], size: f64, rot: bool) {
        for p in self.panels.iter_mut().filter(|p| ids.contains(&p.id)) {
            p.tex_size = size.max(10.0);
            p.tex_rot = rot;
        }
    }

    /// key: "" (auto wg grubości), "chipboard", "mdf", "hdf", "plywood", "pine".
    pub fn set_material(&mut self, ids: &[u32], key: &str) {
        if !key.is_empty() && !MATS.iter().any(|m| m.key == key) {
            return;
        }
        for p in self.panels.iter_mut().filter(|p| ids.contains(&p.id)) {
            p.material = key.to_string();
        }
    }

    /// Masa płyt (objętość minus otwory, razy gęstość), okleiny i środek ciężkości (JSON). Bez okuć.
    pub fn mass_report(&self) -> String {
        let mut rows = vec![];
        let mut sum = 0.0;
        let mut edging = 0.0;
        let mut cog = [0.0; 3];
        let mut bmin = [f64::MAX; 3];
        let mut bmax = [f64::MIN; 3];
        for p in &self.panels {
            let m = panel_mass_kg(p);
            sum += m;
            edging += edging_mass_kg(p);
            for a in 0..3 {
                cog[a] += m * (p.pos[a] + p.size[a] / 2.0);
                bmin[a] = bmin[a].min(p.pos[a]);
                bmax[a] = bmax[a].max(p.pos[a] + p.size[a]);
            }
            rows.push(MassRow {
                id: p.id,
                name: p.name.clone(),
                material: mat_for(p).key.to_string(),
                mass_kg: m,
                holes: p.holes.len(),
            });
        }
        if sum > 0.0 {
            for c in cog.iter_mut() {
                *c /= sum;
            }
        }
        if rows.is_empty() {
            bmin = [0.0; 3];
            bmax = [0.0; 3];
        }
        let rep = MassReport { rows, panels_kg: sum, edging_kg: edging, total_kg: sum + edging, cog, bbox_min: bmin, bbox_max: bmax };
        serde_json::to_string(&rep).unwrap_or_else(|_| "{}".into())
    }

    /// Orientacyjna nośność poziomej płyty (półki): belka swobodnie podparta na końcach, obciążenie
    /// równomierne na całej rozpiętości `span` (mm). Ugięcie dopuszczalne = span/ratio.
    /// Zwraca dopuszczalne obciążenie [kg] chwilowe i długotrwałe (z pełzaniem materiału). JSON.
    /// To nie jest obliczenie konstrukcyjne: nie uwzględnia nośności kołków i łączników ani wilgoci.
    pub fn shelf_capacity(&self, id: u32, span: f64, ratio: f64) -> String {
        let Some(i) = self.find(id) else { return "{}".into() };
        let p = &self.panels[i];
        let m = mat_for(p);
        let ax = axes_by_size(&p.size);
        let (long, b, h) = (p.size[ax[0]], p.size[ax[1]], p.size[ax[2]]);
        let span = span.max(10.0);
        let ratio = ratio.max(50.0);
        let own_n = panel_mass_kg(p) * 9.81 * (span / long).min(1.0);
        let inertia = b * h.powi(3) / 12.0; // mm^4
        let wmod = b * h * h / 6.0; // mm^3
        // 5 W L^3 / (384 E I) = L / ratio   ->   W [N]
        let defl_short = 384.0 * m.e * inertia * (span / ratio) / (5.0 * span.powi(3));
        let defl_long = defl_short / (1.0 + m.kdef);
        // M = W L / 8 <= (fm / 3) * Wmod
        let bend = 8.0 * (m.fm / 3.0) * wmod / span;
        let kg = |n: f64| (n / 9.81).max(0.0);
        serde_json::json!({
            "material": m.key,
            "thickness": h,
            "width": b,
            "span": span,
            "e": m.e,
            "fm": m.fm,
            "kdef": m.kdef,
            "self_kg": own_n / 9.81,
            "bend_kg": kg(bend),
            "allow_short_kg": kg(defl_short.min(bend) - own_n),
            "allow_long_kg": kg(defl_long.min(bend) - own_n),
        })
        .to_string()
    }

    /// Które sąsiednie płyty są teraz wyrównane z zaznaczeniem (krawędź lub środek)? JSON.
    /// Służy tylko do podświetleń na scenie.
    pub fn snap_guides(&self, ids: &[u32], tol: f64) -> String {
        const EPS: f64 = 0.01;
        let Some((min, max)) = self.bbox(ids) else { return "[]".into() };
        let mut out: Vec<Guide> = vec![];
        for p in self.panels.iter().filter(|p| !ids.contains(&p.id)) {
            let near = (0..3).all(|b| min[b] <= p.pos[b] + p.size[b] + tol && max[b] >= p.pos[b] - tol);
            if !near {
                continue;
            }
            for a in 0..3 {
                let (lo, hi) = (min[a], max[a]);
                let (omin, omax) = (p.pos[a], p.pos[a] + p.size[a]);
                let edge = [(lo, omin), (lo, omax), (hi, omin), (hi, omax)]
                    .iter()
                    .any(|&(m, t)| (m - t).abs() < EPS);
                let center = ((lo + hi) - (omin + omax)).abs() / 2.0 < EPS;
                if edge || center {
                    out.push(Guide { id: p.id, axis: a, center });
                }
            }
        }
        serde_json::to_string(&out).unwrap_or_else(|_| "[]".into())
    }

    // ---------- grupy ----------

    pub fn group(&mut self, ids: &[u32]) {
        if ids.len() < 2 {
            return;
        }
        let g = self.next_group;
        self.next_group += 1;
        for p in self.panels.iter_mut().filter(|p| ids.contains(&p.id)) {
            p.group = g;
        }
    }

    pub fn ungroup(&mut self, ids: &[u32]) {
        let groups: Vec<u32> = self
            .panels
            .iter()
            .filter(|p| ids.contains(&p.id) && p.group != 0)
            .map(|p| p.group)
            .collect();
        for p in self.panels.iter_mut().filter(|p| groups.contains(&p.group)) {
            p.group = 0;
        }
    }

    // ---------- zapis ----------

    pub fn to_json(&self) -> String {
        serde_json::to_string(&self.panels).unwrap_or_else(|_| "[]".into())
    }

    pub fn load_json(&mut self, json: &str) -> bool {
        match serde_json::from_str::<Vec<Panel>>(json) {
            Ok(v) => {
                self.next_id = v.iter().map(|p| p.id).max().unwrap_or(0) + 1;
                self.next_group = v.iter().map(|p| p.group).max().unwrap_or(0) + 1;
                self.panels = v;
                true
            }
            Err(_) => false,
        }
    }
}
