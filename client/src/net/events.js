export class Events {
  constructor() { this.listeners = new Map(); }
  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type)?.delete(fn);
  }
  emit(type, value) { for (const fn of this.listeners.get(type) || []) fn(value); }
}
