// Flat-config ESLint (v9+). Single config for the whole monorepo —
// per-package rules can override if needed but the baseline is
// strict TS + import hygiene + zero warnings allowed in CI.

import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import reactHooks from 'eslint-plugin-react-hooks'
import prettierConfig from 'eslint-config-prettier'

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-types/**',
      '**/build/**',
      '**/coverage/**',
      '**/drizzle/**',
      '**/playwright-report/**',
      '**/test-results/**',
      // Agent worktrees are sandboxed branches — lint runs on the main checkout only.
      '.claude/worktrees/**',
    ],
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-implicit-coercion': 'error',
    },
  },
  {
    // The SPA only. Rules are listed explicitly rather than spread from
    // the plugin's `recommended`, which carries the whole React Compiler
    // rule set — a much larger change than the dependency bugs these two
    // catch (an effect whose deps lie re-runs every render, or never).
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  prettierConfig,
]
