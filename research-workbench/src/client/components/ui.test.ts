import { describe, expect, it } from 'vitest';
import { editorWrites } from './ui';

// A cell or text editor can stay open while the poll applies a newer draft (an AI client or
// another window changed the same field). Closing it must not write the stale text back.
describe('editors open while the draft changes underneath', () => {
  it('an untouched editor does not write its old value over the newer one', () => {
    // opened on 30%; an AI set 33% meanwhile; the user presses Enter / clicks away without typing
    expect(editorWrites(false, 0.3, 0.33)).toBe(false);
    expect(editorWrites(false, 'old note', 'the note the AI wrote')).toBe(false);
  });

  it('writes what the user typed, unless it equals the current value', () => {
    expect(editorWrites(true, 0.3, 0.33)).toBe(true);
    expect(editorWrites(true, 'my note', 'the note the AI wrote')).toBe(true);
    expect(editorWrites(true, 0.33, 0.33)).toBe(false);
  });
});
