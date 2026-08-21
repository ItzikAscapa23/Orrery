import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';

export default [
  // Base JS recommended — applies to all files
  js.configs.recommended,

  // TypeScript + TSX files: type-checked rules
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: {
      '@typescript-eslint': tseslint,
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      ...tseslint.configs['recommended-type-checked'].rules,
      // TypeScript's own checker makes no-undef redundant for TS files and it
      // false-positives on TS-only types (BufferEncoding, NodeJS.*, React, etc.)
      'no-undef': 'off',
      // Base rule must be off; @typescript-eslint/no-unused-vars handles this
      'no-unused-vars': 'off',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message: 'No default exports (CLAUDE.md convention).',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // Test files: relax type-safety rules that are correct in test code.
  // vi.mocked(), `as unknown as T` casts, and mock return values produce `any`
  // legitimately — suppressing per-line would create hundreds of comments.
  {
    files: ['**/__tests__/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },

  // Prettier last — disables conflicting formatting rules, adds prettier/prettier error
  prettierRecommended,

  // Ignore patterns
  {
    ignores: [
      'node_modules/',
      'dist/',
      'docs/',
      'apps/server/prisma/',
      '**/*.config.cjs',
      '**/*.config.ts',
      'vitest.workspace.ts',
      'scripts/',
    ],
  },
];
