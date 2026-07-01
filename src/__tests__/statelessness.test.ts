/**
 * Fix 2: Executable statelessness assertion
 *
 * The SECURITY-CRITICAL comment in src/http.ts mandates that the
 * StreamableHTTPServerTransport stays stateless (sessionIdGenerator: undefined).
 * A stateful/session-generating transport could let long-lived connections serve
 * later messages under a stale/foreign credential context, breaking tenant isolation.
 *
 * These tests assert directly against the source file (always present, no build
 * dependency) and optionally against the compiled dist (bonus check, skipped when
 * dist is absent so CI never flakes on a cold build).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const srcPath = resolve(process.cwd(), 'src/http.ts');
const distPath = resolve(process.cwd(), 'dist/http.js');

describe('HTTP transport statelessness (src/http.ts)', () => {
  it('src/http.ts does NOT contain randomUUID (no session ID generator)', () => {
    if (!existsSync(srcPath)) {
      throw new Error(`Source file not found at ${srcPath} — check working directory`);
    }
    const src = readFileSync(srcPath, 'utf-8');
    expect(src).not.toContain('randomUUID');
  });

  it('src/http.ts does NOT contain a session-generating lambda (sessionIdGenerator: () =>)', () => {
    const src = readFileSync(srcPath, 'utf-8');
    // Any arrow-function or function expression assigned to sessionIdGenerator
    // would introduce per-request session IDs, breaking statelessness
    expect(src).not.toMatch(/sessionIdGenerator\s*:\s*\(\s*\)/);
  });

  it('src/http.ts explicitly sets sessionIdGenerator: undefined', () => {
    const src = readFileSync(srcPath, 'utf-8');
    expect(src).toContain('sessionIdGenerator: undefined');
  });
});

describe('HTTP transport statelessness (dist/http.js — bonus, skipped when absent)', () => {
  it('dist/http.js has no randomUUID when built', () => {
    if (!existsSync(distPath)) {
      // Not a failure — dist simply hasn't been built yet in this environment.
      // Run `npm run build` to enable this check.
      console.warn(`[statelessness] dist/http.js not found — skipping dist assertion (run npm run build first)`);
      return;
    }
    const dist = readFileSync(distPath, 'utf-8');
    expect(dist).not.toContain('randomUUID');
  });

  it('dist/http.js does not contain a session-generating lambda when built', () => {
    if (!existsSync(distPath)) {
      console.warn(`[statelessness] dist/http.js not found — skipping dist assertion (run npm run build first)`);
      return;
    }
    const dist = readFileSync(distPath, 'utf-8');
    expect(dist).not.toMatch(/sessionIdGenerator\s*:\s*\(\s*\)/);
  });
});
