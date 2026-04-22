// Generic undo/redo stack working on JSON-cloned snapshots.
const MAX_LEVELS = 50;

export class History {
  constructor(maxLevels = MAX_LEVELS) {
    this.max = maxLevels;
    this.undoStack = [];
    this.redoStack = [];
  }
  clear() { this.undoStack.length = 0; this.redoStack.length = 0; }
  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  // current: function returning a clone of current state
  push(snapshot) {
    if (this.undoStack.length >= this.max) this.undoStack.shift();
    this.undoStack.push(snapshot);
    this.redoStack.length = 0;
  }
  undo(currentSnapshot) {
    if (!this.undoStack.length) return null;
    this.redoStack.push(currentSnapshot);
    return this.undoStack.pop();
  }
  redo(currentSnapshot) {
    if (!this.redoStack.length) return null;
    this.undoStack.push(currentSnapshot);
    return this.redoStack.pop();
  }
}
