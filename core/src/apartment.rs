//! Moduł mieszkania: ściany, wstawione meble, cofanie/ponawianie.
//! Wymiary w mm. Plan leży na płaszczyźnie XZ (Y = wysokość), jak w edytorze mebli.

use crate::Panel;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

/// Drzwi lub okno w ścianie. `pos` = odległość lewej krawędzi otworu od punktu A, mierzona po osi ściany.
#[derive(Serialize, Deserialize, Clone, PartialEq)]
pub struct Opening {
    pub id: u32,
    pub kind: String, // "door" albo "window"
    pub pos: f64,
    pub width: f64,
    pub height: f64,
    pub sill: f64, // wysokość dolnej krawędzi nad podłogą (drzwi: 0)
}

#[derive(Serialize, Deserialize, Clone, PartialEq)]
pub struct Wall {
    pub id: u32,
    pub a: [f64; 2],
    pub b: [f64; 2],
    pub thickness: f64,
    pub height: f64,
    #[serde(default)]
    pub openings: Vec<Opening>,
}

/// Wstawiony mebel. Płyty są zapisane względem środka obrysu mebla (w osiach X i Z),
/// `pos` = miejsce tego środka w mieszkaniu, `rot` = obrót o rot*90° wokół osi Y.
#[derive(Serialize, Deserialize, Clone, PartialEq)]
pub struct Instance {
    pub id: u32,
    pub name: String,
    pub pos: [f64; 2],
    pub rot: u32,
    pub panels: Vec<Panel>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Default)]
pub struct State {
    #[serde(default)]
    pub walls: Vec<Wall>,
    #[serde(default)]
    pub instances: Vec<Instance>,
}

#[derive(Serialize)]
struct WorldBox {
    inst: u32,
    name: String,
    pos: [f64; 3],
    size: [f64; 3],
    color: String,
    texture: String,
    tex_size: f64,
    tex_rot: bool,
}

type Rect = ([f64; 2], [f64; 2]);

fn wall_len(w: &Wall) -> f64 {
    (w.b[0] - w.a[0]).hypot(w.b[1] - w.a[1])
}

/// Czy otwór [pos, pos+width] mieści się na ścianie i nie nachodzi na inne otwory (poza `ignore`)?
fn opening_fits(w: &Wall, pos: f64, width: f64, ignore: u32) -> bool {
    if pos < -0.001 || width < 1.0 || pos + width > wall_len(w) + 0.001 {
        return false;
    }
    w.openings
        .iter()
        .filter(|o| o.id != ignore)
        .all(|o| pos + width <= o.pos + 0.001 || pos >= o.pos + o.width - 0.001)
}

/// Płyta po obrocie o `rot`*90° wokół środka (0,0) i przesunięciu o `pos`: (narożnik min, rozmiar).
fn rotated_box(p: &Panel, rot: u32, pos: [f64; 2]) -> ([f64; 3], [f64; 3]) {
    let (mut x, mut z, mut sx, mut sz) = (p.pos[0], p.pos[2], p.size[0], p.size[2]);
    for _ in 0..(rot % 4) {
        let (nx, nz) = (-(z + sz), x);
        let (nsx, nsz) = (sz, sx);
        x = nx;
        z = nz;
        sx = nsx;
        sz = nsz;
    }
    ([x + pos[0], p.pos[1], z + pos[1]], [sx, p.size[1], sz])
}

/// Obrys mebla względem jego `pos`.
fn extent(inst: &Instance) -> Rect {
    let mut min = [f64::MAX; 2];
    let mut max = [f64::MIN; 2];
    for p in &inst.panels {
        let (pos, size) = rotated_box(p, inst.rot, [0.0, 0.0]);
        min[0] = min[0].min(pos[0]);
        min[1] = min[1].min(pos[2]);
        max[0] = max[0].max(pos[0] + size[0]);
        max[1] = max[1].max(pos[2] + size[2]);
    }
    (min, max)
}

#[wasm_bindgen]
pub struct Apartment {
    state: State,
    next_id: u32,
    undo_stack: Vec<State>,
    redo_stack: Vec<State>,
}

impl Apartment {
    /// Prostokąty, do których przyciągają się meble: ściany równoległe do osi + inne meble.
    fn obstacle_rects(&self, exclude: u32) -> Vec<Rect> {
        let mut out = vec![];
        for w in &self.state.walls {
            let h = w.thickness / 2.0;
            if (w.a[0] - w.b[0]).abs() < 0.5 {
                out.push(([w.a[0] - h, w.a[1].min(w.b[1]) - h], [w.a[0] + h, w.a[1].max(w.b[1]) + h]));
            } else if (w.a[1] - w.b[1]).abs() < 0.5 {
                out.push(([w.a[0].min(w.b[0]) - h, w.a[1] - h], [w.a[0].max(w.b[0]) + h, w.a[1] + h]));
            }
        }
        for i in self.state.instances.iter().filter(|i| i.id != exclude) {
            let (mn, mx) = extent(i);
            out.push(([mn[0] + i.pos[0], mn[1] + i.pos[1]], [mx[0] + i.pos[0], mx[1] + i.pos[1]]));
        }
        out
    }
}

#[wasm_bindgen]
impl Apartment {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Apartment {
        Apartment { state: State::default(), next_id: 1, undo_stack: vec![], redo_stack: vec![] }
    }

    // ---------- cofnij / ponów ----------

    pub fn checkpoint(&mut self) {
        self.undo_stack.push(self.state.clone());
        if self.undo_stack.len() > 100 {
            self.undo_stack.remove(0);
        }
        self.redo_stack.clear();
    }

    pub fn undo(&mut self) -> bool {
        while let Some(prev) = self.undo_stack.pop() {
            if prev != self.state {
                self.redo_stack.push(std::mem::replace(&mut self.state, prev));
                return true;
            }
        }
        false
    }

    pub fn redo(&mut self) -> bool {
        while let Some(next) = self.redo_stack.pop() {
            if next != self.state {
                self.undo_stack.push(std::mem::replace(&mut self.state, next));
                return true;
            }
        }
        false
    }

    // ---------- ściany ----------

    /// Zwraca id nowej ściany albo 0, jeśli jest krótsza niż 1 mm.
    pub fn add_wall(&mut self, ax: f64, az: f64, bx: f64, bz: f64, thickness: f64, height: f64) -> u32 {
        if (bx - ax).hypot(bz - az) < 1.0 {
            return 0;
        }
        let id = self.next_id;
        self.next_id += 1;
        self.state.walls.push(Wall {
            id,
            a: [ax.round(), az.round()],
            b: [bx.round(), bz.round()],
            thickness: thickness.max(1.0),
            height: height.max(1.0),
            openings: vec![],
        });
        id
    }

    pub fn set_wall(&mut self, id: u32, thickness: f64, height: f64) {
        if let Some(w) = self.state.walls.iter_mut().find(|w| w.id == id) {
            w.thickness = thickness.max(1.0);
            w.height = height.max(1.0);
        }
    }

    /// Ustawia długość ściany (mierzoną po osi, między punktami A i B).
    /// `anchor`: 0 = A stoi, rusza się B; 1 = B stoi, rusza się A; 2 = rozciągnij na obie strony.
    /// `drag_connected`: ściany połączone z przesuwanym końcem idą razem z nim.
    pub fn set_wall_length(&mut self, id: u32, length: f64, anchor: u32, drag_connected: bool) {
        let length = length.max(1.0);
        let Some(i) = self.state.walls.iter().position(|w| w.id == id) else { return };
        let (a, b) = (self.state.walls[i].a, self.state.walls[i].b);
        let cur = (b[0] - a[0]).hypot(b[1] - a[1]);
        if cur < 1e-9 {
            return;
        }
        let (ux, uz) = ((b[0] - a[0]) / cur, (b[1] - a[1]) / cur);
        let (na, nb) = match anchor {
            0 => (a, [a[0] + ux * length, a[1] + uz * length]),
            1 => ([b[0] - ux * length, b[1] - uz * length], b),
            _ => {
                let m = [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0];
                (
                    [m[0] - ux * length / 2.0, m[1] - uz * length / 2.0],
                    [m[0] + ux * length / 2.0, m[1] + uz * length / 2.0],
                )
            }
        };
        if drag_connected {
            let close = |p: [f64; 2], q: [f64; 2]| (p[0] - q[0]).abs() < 0.5 && (p[1] - q[1]).abs() < 0.5;
            for (k, w) in self.state.walls.iter_mut().enumerate() {
                if k == i {
                    continue;
                }
                for e in [&mut w.a, &mut w.b] {
                    if close(*e, a) {
                        *e = na;
                    } else if close(*e, b) {
                        *e = nb;
                    }
                }
            }
        }
        let shift = match anchor {
            0 => 0.0,
            1 => length - cur,
            _ => (length - cur) / 2.0,
        };
        for o in &mut self.state.walls[i].openings {
            o.pos += shift; // punkt A się przesunął, otwory zostają na swoich miejscach
        }
        self.state.walls[i].a = na;
        self.state.walls[i].b = nb;
    }

    /// Przesuwa całą ścianę tak, by punkt A trafił w (ax, az). Końce przyciągają się do końców innych ścian.
    /// `drag_connected`: ściany połączone z końcami tej ściany rozciągają się razem z nią.
    pub fn move_wall(&mut self, id: u32, ax: f64, az: f64, tol: f64, drag_connected: bool) {
        let Some(i) = self.state.walls.iter().position(|w| w.id == id) else { return };
        let (a, b) = (self.state.walls[i].a, self.state.walls[i].b);
        let close = |p: [f64; 2], q: [f64; 2]| (p[0] - q[0]).abs() < 0.5 && (p[1] - q[1]).abs() < 0.5;
        let mut na = [ax.round(), az.round()];
        if tol > 0.0 {
            let off = [b[0] - a[0], b[1] - a[1]];
            let mut best: Option<(f64, [f64; 2])> = None;
            for (k, w2) in self.state.walls.iter().enumerate() {
                if k == i {
                    continue;
                }
                for p in [w2.a, w2.b] {
                    if drag_connected && (close(p, a) || close(p, b)) {
                        continue; // połączone końce jadą razem, nie mogą być celem przyciągania
                    }
                    for mine in [na, [na[0] + off[0], na[1] + off[1]]] {
                        let d = [p[0] - mine[0], p[1] - mine[1]];
                        let dist = d[0].hypot(d[1]);
                        if dist <= tol && best.map_or(true, |(bd, _)| dist < bd) {
                            best = Some((dist, d));
                        }
                    }
                }
            }
            if let Some((_, d)) = best {
                na = [na[0] + d[0], na[1] + d[1]];
            }
        }
        let d = [na[0] - a[0], na[1] - a[1]];
        let nb = [b[0] + d[0], b[1] + d[1]];
        if drag_connected {
            for (k, w2) in self.state.walls.iter_mut().enumerate() {
                if k == i {
                    continue;
                }
                for e in [&mut w2.a, &mut w2.b] {
                    if close(*e, a) {
                        *e = na;
                    } else if close(*e, b) {
                        *e = nb;
                    }
                }
            }
        }
        self.state.walls[i].a = na;
        self.state.walls[i].b = nb;
    }

    /// Wydłuża/skraca ścianę, przeciągając jej koniec (end: 0 = A, 1 = B) wzdłuż osi ściany.
    /// (x, z) = punkt myszy, `grab` = przesunięcie chwytu. Koniec przyciąga się do innych ścian.
    pub fn drag_wall_end(&mut self, id: u32, end: u32, x: f64, z: f64, grab: f64, tol: f64, drag_connected: bool) {
        let Some(i) = self.state.walls.iter().position(|w| w.id == id) else { return };
        let (a, b) = (self.state.walls[i].a, self.state.walls[i].b);
        let (fixed, moving) = if end == 0 { (b, a) } else { (a, b) };
        let len = (moving[0] - fixed[0]).hypot(moving[1] - fixed[1]);
        if len < 1e-9 {
            return;
        }
        let d = [(moving[0] - fixed[0]) / len, (moving[1] - fixed[1]) / len];
        let close = |p: [f64; 2], q: [f64; 2]| (p[0] - q[0]).abs() < 0.5 && (p[1] - q[1]).abs() < 0.5;
        let mut t = (x - fixed[0]) * d[0] + (z - fixed[1]) * d[1] + grab;
        if tol > 0.0 {
            let mut cands: Vec<f64> = vec![];
            for (k, w2) in self.state.walls.iter().enumerate() {
                if k == i || (drag_connected && (close(w2.a, moving) || close(w2.b, moving))) {
                    continue;
                }
                let v = [w2.b[0] - w2.a[0], w2.b[1] - w2.a[1]];
                let den = d[0] * v[1] - d[1] * v[0];
                if den.abs() > 1e-9 {
                    // gdzie oś tej ściany przecina oś innej ściany
                    let (wx, wz) = (w2.a[0] - fixed[0], w2.a[1] - fixed[1]);
                    let tt = (wx * v[1] - wz * v[0]) / den;
                    let s = (wx * d[1] - wz * d[0]) / den;
                    if (-0.02..=1.02).contains(&s) {
                        cands.push(tt);
                    }
                }
                for p in [w2.a, w2.b] {
                    let (px, pz) = (p[0] - fixed[0], p[1] - fixed[1]);
                    if (px * d[1] - pz * d[0]).abs() <= tol {
                        cands.push(px * d[0] + pz * d[1]);
                    }
                }
            }
            let snapped = cands
                .into_iter()
                .filter(|c| (c - t).abs() <= tol)
                .min_by(|p, q| (p - t).abs().total_cmp(&(q - t).abs()));
            if let Some(c) = snapped {
                t = c;
            }
        }
        let t = t.max(1.0);
        let nm = [fixed[0] + d[0] * t, fixed[1] + d[1] * t];
        if drag_connected {
            for (k, w2) in self.state.walls.iter_mut().enumerate() {
                if k == i {
                    continue;
                }
                for e in [&mut w2.a, &mut w2.b] {
                    if close(*e, moving) {
                        *e = nm;
                    }
                }
            }
        }
        if end == 0 {
            let shift = t - len;
            for o in &mut self.state.walls[i].openings {
                o.pos += shift;
            }
            self.state.walls[i].a = nm;
        } else {
            self.state.walls[i].b = nm;
        }
    }

    /// Poszerza ścianę, przeciągając jej bok (side: +1 / -1). Przeciwny bok stoi w miejscu,
    /// więc oś ściany się przesuwa. Bok przyciąga się do boków równoległych ścian.
    pub fn drag_wall_face(&mut self, id: u32, side: i32, x: f64, z: f64, grab: f64, tol: f64) {
        let Some(i) = self.state.walls.iter().position(|w| w.id == id) else { return };
        let w = self.state.walls[i].clone();
        let len = (w.b[0] - w.a[0]).hypot(w.b[1] - w.a[1]);
        if len < 1e-9 {
            return;
        }
        let u = [(w.b[0] - w.a[0]) / len, (w.b[1] - w.a[1]) / len];
        let n = [-u[1], u[0]];
        let mut off = (x - w.a[0]) * n[0] + (z - w.a[1]) * n[1] + grab;
        if tol > 0.0 {
            let mut cands: Vec<f64> = vec![];
            for (k, w2) in self.state.walls.iter().enumerate() {
                if k == i {
                    continue;
                }
                let v = [w2.b[0] - w2.a[0], w2.b[1] - w2.a[1]];
                let vl = v[0].hypot(v[1]);
                if vl < 1e-9 || (u[0] * v[1] - u[1] * v[0]).abs() / vl > 0.02 {
                    continue; // tylko ściany równoległe
                }
                let c = (w2.a[0] - w.a[0]) * n[0] + (w2.a[1] - w.a[1]) * n[1];
                cands.push(c - w2.thickness / 2.0);
                cands.push(c + w2.thickness / 2.0);
            }
            let snapped = cands
                .into_iter()
                .filter(|c| (c - off).abs() <= tol)
                .min_by(|p, q| (p - off).abs().total_cmp(&(q - off).abs()));
            if let Some(c) = snapped {
                off = c;
            }
        }
        let half = w.thickness / 2.0;
        let (mut lo, mut hi) = if side > 0 { (-half, off) } else { (off, half) };
        if hi - lo < 1.0 {
            if side > 0 {
                hi = lo + 1.0;
            } else {
                lo = hi - 1.0;
            }
        }
        let shift = (lo + hi) / 2.0;
        let wm = &mut self.state.walls[i];
        wm.a = [w.a[0] + n[0] * shift, w.a[1] + n[1] * shift];
        wm.b = [w.b[0] + n[0] * shift, w.b[1] + n[1] * shift];
        wm.thickness = hi - lo;
    }

    // ---------- drzwi i okna ----------

    /// Dodaje drzwi (kind = "door") lub okno ("window") w wolnym miejscu najbliżej środka ściany.
    /// Zwraca id albo 0, gdy brak miejsca.
    pub fn add_opening(&mut self, wall_id: u32, kind: &str, width: f64, height: f64, sill: f64) -> u32 {
        let Some(i) = self.state.walls.iter().position(|w| w.id == wall_id) else { return 0 };
        let (width, sill) = (width.max(50.0), sill.max(0.0));
        let wall = &self.state.walls[i];
        let height = height.max(50.0).min(wall.height - sill);
        if height < 50.0 {
            return 0;
        }
        let len = wall_len(wall);
        let mut best: Option<(f64, f64)> = None;
        let mut pos = 0.0;
        while pos + width <= len + 0.001 {
            if opening_fits(wall, pos, width, 0) {
                let dist = (pos + width / 2.0 - len / 2.0).abs();
                if best.map_or(true, |(bd, _)| dist < bd) {
                    best = Some((dist, pos));
                }
            }
            pos += 50.0;
        }
        let Some((_, pos)) = best else { return 0 };
        let id = self.next_id;
        self.next_id += 1;
        let kind = if kind == "window" { "window" } else { "door" };
        self.state.walls[i].openings.push(Opening { id, kind: kind.to_string(), pos, width, height, sill });
        id
    }

    /// Zmienia położenie i wymiary otworu. Zwraca false (bez zmian), gdy się nie mieści albo nachodzi na inny.
    pub fn set_opening(&mut self, wall_id: u32, opening_id: u32, pos: f64, width: f64, height: f64, sill: f64) -> bool {
        let Some(i) = self.state.walls.iter().position(|w| w.id == wall_id) else { return false };
        let Some(j) = self.state.walls[i].openings.iter().position(|o| o.id == opening_id) else { return false };
        let (width, height, sill) = (width.max(50.0), height.max(50.0), sill.max(0.0));
        if sill + height > self.state.walls[i].height + 0.001 || !opening_fits(&self.state.walls[i], pos, width, opening_id) {
            return false;
        }
        let o = &mut self.state.walls[i].openings[j];
        o.pos = pos;
        o.width = width;
        o.height = height;
        o.sill = sill;
        true
    }

    pub fn remove_opening(&mut self, wall_id: u32, opening_id: u32) {
        if let Some(w) = self.state.walls.iter_mut().find(|w| w.id == wall_id) {
            w.openings.retain(|o| o.id != opening_id);
        }
    }

    /// Usuwa ściany i meble o podanych id.
    pub fn remove(&mut self, ids: &[u32]) {
        self.state.walls.retain(|w| !ids.contains(&w.id));
        self.state.instances.retain(|i| !ids.contains(&i.id));
    }

    /// Przyciąga punkt rysowania: do końców istniejących ścian (w promieniu `tol`),
    /// a przy `ortho` także do poziomu/pionu względem poprzedniego punktu. Zwraca JSON [x, z].
    pub fn snap_point(&self, x: f64, z: f64, tol: f64, from_x: f64, from_z: f64, ortho: bool) -> String {
        let (mut px, mut pz) = (x, z);
        if ortho {
            if (x - from_x).abs() >= (z - from_z).abs() {
                pz = from_z;
            } else {
                px = from_x;
            }
        }
        let mut best: Option<(f64, [f64; 2])> = None;
        for w in &self.state.walls {
            for p in [w.a, w.b] {
                let d = (p[0] - x).hypot(p[1] - z);
                if d <= tol && best.map_or(true, |(bd, _)| d < bd) {
                    best = Some((d, p));
                }
            }
        }
        let out = match best {
            Some((_, p)) => p,
            None => [px.round(), pz.round()],
        };
        serde_json::to_string(&out).unwrap_or_else(|_| "[0,0]".into())
    }

    // ---------- meble ----------

    /// Wstawia mebel (JSON z edytora mebli) ze środkiem w (x, z). Zwraca id albo 0 przy błędzie.
    pub fn add_instance(&mut self, name: &str, furniture_json: &str, x: f64, z: f64) -> u32 {
        let Ok(mut panels) = serde_json::from_str::<Vec<Panel>>(furniture_json) else { return 0 };
        if panels.is_empty() {
            return 0;
        }
        let mut min = [f64::MAX; 2];
        let mut max = [f64::MIN; 2];
        for p in &panels {
            min[0] = min[0].min(p.pos[0]);
            min[1] = min[1].min(p.pos[2]);
            max[0] = max[0].max(p.pos[0] + p.size[0]);
            max[1] = max[1].max(p.pos[2] + p.size[2]);
        }
        let (cx, cz) = ((min[0] + max[0]) / 2.0, (min[1] + max[1]) / 2.0);
        for p in &mut panels {
            p.pos[0] -= cx;
            p.pos[2] -= cz;
        }
        let id = self.next_id;
        self.next_id += 1;
        self.state.instances.push(Instance {
            id,
            name: name.to_string(),
            pos: [x.round(), z.round()],
            rot: 0,
            panels,
        });
        id
    }

    /// Przesuwa mebel (środek w x, z). `tol` > 0 włącza przyciąganie do ścian i innych mebli.
    pub fn move_instance(&mut self, id: u32, x: f64, z: f64, tol: f64) {
        let Some(i) = self.state.instances.iter().position(|q| q.id == id) else { return };
        let want = [x.round(), z.round()];
        let mut out = want;
        if tol > 0.0 {
            let (mn, mx) = extent(&self.state.instances[i]);
            let size = [mx[0] - mn[0], mx[1] - mn[1]];
            let lo = [want[0] + mn[0], want[1] + mn[1]];
            let rects = self.obstacle_rects(id);
            for a in 0..2 {
                let o = 1 - a;
                let mut best: Option<f64> = None;
                for (rmin, rmax) in &rects {
                    // tylko przeszkody w pobliżu na drugiej osi
                    if lo[o] > rmax[o] + tol || lo[o] + size[o] < rmin[o] - tol {
                        continue;
                    }
                    for (mine, target) in [
                        (lo[a], rmin[a]),
                        (lo[a], rmax[a]),
                        (lo[a] + size[a], rmin[a]),
                        (lo[a] + size[a], rmax[a]),
                    ] {
                        let d = target - mine;
                        if d.abs() <= tol && best.map_or(true, |b| d.abs() < b.abs()) {
                            best = Some(d);
                        }
                    }
                }
                out[a] = want[a] + best.unwrap_or(0.0);
            }
        }
        self.state.instances[i].pos = out;
    }

    pub fn rotate_instance(&mut self, id: u32) {
        if let Some(i) = self.state.instances.iter_mut().find(|q| q.id == id) {
            i.rot = (i.rot + 1) % 4;
        }
    }

    /// Wszystkie płyty wstawionych mebli we współrzędnych mieszkania (JSON).
    pub fn world_boxes(&self) -> String {
        let mut out: Vec<WorldBox> = vec![];
        for i in &self.state.instances {
            for p in &i.panels {
                let (pos, size) = rotated_box(p, i.rot, i.pos);
                out.push(WorldBox {
                    inst: i.id,
                    name: i.name.clone(),
                    pos,
                    size,
                    color: p.color.clone(),
                    texture: p.texture.clone(),
                    tex_size: p.tex_size,
                    tex_rot: p.tex_rot,
                });
            }
        }
        serde_json::to_string(&out).unwrap_or_else(|_| "[]".into())
    }

    // ---------- zapis ----------

    pub fn to_json(&self) -> String {
        serde_json::to_string(&self.state).unwrap_or_else(|_| "{}".into())
    }

    pub fn load_json(&mut self, json: &str) -> bool {
        match serde_json::from_str::<State>(json) {
            Ok(s) => {
                let m1 = s.walls.iter().map(|w| w.id).max().unwrap_or(0);
                let m2 = s.instances.iter().map(|i| i.id).max().unwrap_or(0);
                self.next_id = m1.max(m2) + 1;
                self.state = s;
                true
            }
            Err(_) => false,
        }
    }
}
