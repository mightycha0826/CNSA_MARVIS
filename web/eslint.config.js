// Lint rules for web/ (README section 13). ESLint is not a dependency of the app: run it one-off with
//
//   npx --yes eslint@9 src scripts
//
// from web/ (it needs the network the first time). The rules are the ones that catch what a
// refactor breaks: a name that no longer exists, and code that nothing uses any more.

const readonly = (names) => Object.fromEntries(names.split(' ').map((name) => [name, 'readonly']));

export default [
  {
    files: ['src/**/*.js', 'scripts/**/*.cjs', '*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      // The globals the sources use: the browser's, a worker's (core/mirror.worker.js), and node's
      // (the unit tests, scripts/smoke.cjs). Add a name here when new code needs another one.
      globals: readonly(
        'window document navigator location localStorage performance console fetch URL URLSearchParams Blob ' +
          'WebSocket Worker MessageChannel MutationObserver FontFace OffscreenCanvas AudioWorkletNode XRRigidTransform ' +
          'setTimeout clearTimeout setInterval clearInterval queueMicrotask ' +
          'self postMessage onmessage ' +
          'process require Buffer',
      ),
    },
    rules: {
      'no-undef': 'error',
      'no-const-assign': 'error',
      'no-dupe-keys': 'error',
      'no-import-assign': 'error',
      'no-redeclare': 'error',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-unreachable': 'warn',
      'no-self-assign': 'warn',
      'no-duplicate-imports': 'warn',
    },
  },
];
