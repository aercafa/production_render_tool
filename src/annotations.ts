export type Axis = 'width' | 'depth' | 'height';
export type Point = { x: number; y: number };
export type LineMode = 'orthogonal' | 'free';
export type LabelSide = 'auto' | 'near' | 'far';
export type Endpoint = 'a' | 'b';
export type Mark = { id: number; a: Point; b: Point; value: string; mode: LineMode; side: LabelSide };
export type Notes = { title: string; subtitle: string; dimensions: Record<Axis, string>; marks: Mark[] };

export const blankNotes = (): Notes => ({
  title: '', subtitle: '', dimensions: { width: '', depth: '', height: '' }, marks: [],
});

export function constrainLine(start: Point, end: Point, mode: LineMode): Point {
  if (mode === 'free') return end;
  const vertical = Math.abs(end.y - start.y) >= Math.abs(end.x - start.x);
  return vertical ? { x: start.x, y: end.y } : { x: end.x, y: start.y };
}

export function moveEndpoint(mark: Mark, endpoint: Endpoint, point: Point): Mark {
  if (mark.mode === 'free') return { ...mark, [endpoint]: point };
  // The other point stays fixed, including the orientation of an existing straight dimension.
  const anchor = endpoint === 'a' ? mark.b : mark.a;
  const next = mark.a.x === mark.b.x ? { x: anchor.x, y: point.y } : { x: point.x, y: anchor.y };
  return { ...mark, [endpoint]: next };
}

export function distanceToSegment(p: Point, { a, b }: Mark) {
  const x = b.x - a.x, y = b.y - a.y;
  const length = x*x + y*y;
  const t = length ? Math.max(0, Math.min(1, ((p.x-a.x)*x + (p.y-a.y)*y) / length)) : 0;
  return Math.hypot(p.x - a.x - t*x, p.y - a.y - t*y);
}

export class NoteHistory {
  current = blankNotes();
  private previous: Notes[] = [];
  private next: Notes[] = [];
  get canUndo() { return this.previous.length > 0; }
  get canRedo() { return this.next.length > 0; }

  reset(notes: Notes) {
    this.current = notes;
    this.previous = [];
    this.next = [];
  }

  commit(notes: Notes, before = this.current) {
    if (JSON.stringify(before) === JSON.stringify(notes)) return;
    this.previous.push(before);
    if (this.previous.length > 100) this.previous.shift();
    this.current = notes;
    this.next = [];
  }

  undo() {
    const previous = this.previous.pop();
    if (!previous) return;
    this.next.push(this.current);
    this.current = previous;
  }

  redo() {
    const next = this.next.pop();
    if (!next) return;
    this.previous.push(this.current);
    this.current = next;
  }
}
