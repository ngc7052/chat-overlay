import { defineConfig } from 'vitest/config';

// The pure logic — protocol parsing, emote assembly, colours, config migration,
// update manifest safety, payload selection — is held at 100%. The Electron and
// DOM wiring around it is excluded here and covered by the end-to-end harness in
// test/e2e, which drives a real Electron process rather than asserting on mocks.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/main/index.ts',        // BrowserWindow / Tray / globalShortcut wiring
        'src/boot/index.ts',        // process-level bootstrap; e2e covers it
        'src/preload/index.ts',     // contextBridge surface, no logic
        'src/renderer/index.ts',    // DOM wiring
        'src/renderer/dom.ts',      // DOM wiring
        'src/**/types.ts',
      ],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
