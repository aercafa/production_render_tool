import type { Mark, Point } from './annotations';

export type Rect = { x: number; y: number; w: number; h: number };
export type MarkLabel = { center: Point; anchor: Point; bounds: Rect; displaced: boolean };

const expand = (r: Rect, x: number, y: number): Rect =>
  ({ x: r.x - x, y: r.y - y, w: r.w + 2*x, h: r.h + 2*y });

function rayInterval(p: Point, direction: Point, r: Rect): [number, number] | null {
  let start = -Infinity, end = Infinity;
  for (const [origin, d, lo, hi] of [[p.x, direction.x, r.x, r.x+r.w], [p.y, direction.y, r.y, r.y+r.h]]) {
    if (Math.abs(d) < 1e-8) {
      if (origin < lo || origin > hi) return null;
      continue;
    }
    const a = (lo-origin)/d, b = (hi-origin)/d;
    start = Math.max(start, Math.min(a,b));
    end = Math.min(end, Math.max(a,b));
  }
  return start <= end ? [start,end] : null;
}

/** Place the label beside a mark, accounting for the projected view and nearby labels. */
export function placeMarkLabel(mark: Mark, width: number, height: number, paper: Rect, obstacles: Rect[]): MarkLabel {
  const x = mark.b.x - mark.a.x, y = mark.b.y - mark.a.y;
  const span = Math.hypot(x,y) || 1;
  let near = { x: y/span, y: -x/span };
  // For mostly vertical lines “near” means left; otherwise it means above, independent of drawing direction.
  if ((Math.abs(y) > Math.abs(x) ? near.x : near.y) > 0) near = { x: -near.x, y: -near.y };
  const halfW = width/2, halfH = height/2;
  const allowed = expand(paper, -halfW-8, -halfH-8);
  const blocked = obstacles.map(r => expand(r, halfW+5, halfH+5));
  const start = Math.abs(near.x)*halfW + Math.abs(near.y)*halfH + 7;

  function bestOnSide(direction: Point) {
    let best: (MarkLabel & { cost: number }) | null = null;
    for (const fraction of [.5,.34,.66,.18,.82,.03,.97]) {
      const anchor = { x: mark.a.x+x*fraction, y: mark.a.y+y*fraction };
      const range = rayInterval(anchor, direction, allowed);
      if (!range || range[1] < start) continue;
      const cuts = blocked.map(r => rayInterval(anchor, direction, r))
        .filter((r): r is [number, number] => r !== null).sort((a,b) => a[0]-b[0]);
      let d = Math.max(start, range[0]);
      for (const [a,b] of cuts) {
        if (a > d) break;
        if (b >= d) d = b+.5;
      }
      if (d > range[1]) continue;
      const cost = d + Math.abs(.5-fraction)*span*.55;
      if (best && cost >= best.cost) continue;
      const center = { x: anchor.x + d*direction.x, y: anchor.y + d*direction.y };
      best = { center, anchor, displaced: d > start + 12, bounds: { x:center.x-halfW,y:center.y-halfH,w:width,h:height }, cost };
    }
    return best;
  }

  const a = bestOnSide(near), b = bestOnSide({ x: -near.x, y: -near.y });
  const automatic = a && (!b || a.cost <= b.cost) ? a : b;
  const preferred = mark.side === 'near' ? a ?? b : mark.side === 'far' ? b ?? a : automatic;
  if (preferred) return preferred;

  // The selected side may be too close to a page corner. Search available paper space before falling back.
  const anchor = { x: (mark.a.x+mark.b.x)/2, y: (mark.a.y+mark.b.y)/2 };
  let free: (Point & { cost: number }) | null = null;
  for (let cy = allowed.y; cy <= allowed.y+allowed.h; cy += 22) {
    for (let cx = allowed.x; cx <= allowed.x+allowed.w; cx += 22) {
      if (blocked.some(r => cx >= r.x && cx <= r.x+r.w && cy >= r.y && cy <= r.y+r.h)) continue;
      const cost = (cx-anchor.x)**2+(cy-anchor.y)**2;
      if (!free || cost < free.cost) free = { x:cx,y:cy,cost };
    }
  }
  const center = free ?? { x: Math.max(allowed.x, Math.min(allowed.x+allowed.w, anchor.x)),
    y: Math.max(allowed.y, Math.min(allowed.y+allowed.h, anchor.y)) };
  return { center, anchor, displaced: true, bounds: { x:center.x-halfW,y:center.y-halfH,w:width,h:height } };
}
