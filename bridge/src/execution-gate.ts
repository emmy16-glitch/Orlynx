import fs from 'node:fs';
import path from 'node:path';

/** A bridge-local fence supplements durable admission. A restarted bridge must
 * reconcile an unfinished owner before allowing another runtime to write. */
export class ExecutionGate {
  private active?: { taskId: string; generation: number; adapterId: string; engineSessionId?: string };
  private uncertain = false;
  private fence = 0;
  constructor(private file: string) {
    try { const record = JSON.parse(fs.readFileSync(file, 'utf8')); this.fence = Number(record.fence || 0); this.active = record.active; this.uncertain = Boolean(this.active); } catch {}
  }
  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ fence: this.fence, active: this.active }), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
  enter(taskId: string, generation: number, adapterId: string) {
    if (this.active || this.uncertain) throw new Error('workspace_conflict: previous execution requires reconciliation.');
    if (generation < this.fence) throw new Error('workspace_conflict: stale adapter execution fence.');
    this.fence = generation; this.active = { taskId, generation, adapterId }; this.save();
  }
  session(taskId: string, engineSessionId: string) {
    if (this.active?.taskId === taskId) { this.active.engineSessionId = engineSessionId; this.save(); }
  }
  leave(taskId: string) {
    if (this.active?.taskId === taskId && !this.uncertain) { this.active = undefined; this.save(); }
  }
  current() { return this.active; }
  interrupted() { return this.uncertain; }
  reconcile(generation: number) {
    if (this.active || this.uncertain) throw new Error('workspace_conflict: cannot reconcile an active or uncertain writer.');
    if (generation < this.fence) throw new Error('workspace_conflict: stale transition fence.');
    this.fence = generation; this.save();
  }
}
