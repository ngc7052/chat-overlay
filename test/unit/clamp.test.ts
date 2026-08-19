import { describe, expect, it } from 'vitest';
import { clamp } from '../../src/shared/clamp.js';

describe('clamp', () => {
  it('bounds on both sides and passes through in range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});
