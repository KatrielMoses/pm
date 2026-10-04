import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'coverage/**',
      'reports/**',
      'test-results/**',
      'playwright-report/**',
      'docs/**',
      '.local/**',
      'packages/contracts/src/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-dynamic-delete': 'off',
      // `Promise<T | void>` is the natural type for handlers that may return nothing.
      '@typescript-eslint/no-invalid-void-type': 'off',
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
      // Tenant context may only be set transaction-locally (0C §12.5).
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/set_config\\([^)]*,\\s*false\\)/i]',
          message:
            'Session-level set_config is prohibited; use transaction-local context (0C §12.5).',
        },
        {
          selector: 'Literal[value=/^\\s*SET\\s+(SESSION\\s+)?app\\./i]',
          message: 'Session-level SET of app.* is prohibited (0C §12.5).',
        },
      ],
    },
  },
  {
    // Same-origin pre-paint script (no modules, no imports): browser globals only.
    files: ['apps/web/public/**/*.js'],
    languageOptions: { globals: { ...globals.browser }, sourceType: 'script' },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}', 'apps/web/test/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The browser bundle may import only browser-safe modules.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^@pm/(?!config/public$|contracts/shell$)',
              message:
                'The web app may import only @pm/config/public and @pm/contracts/shell from the workspace.',
            },
            { regex: '^node:', message: 'Node built-ins are not available in the browser.' },
          ],
        },
      ],
    },
  },
  {
    files: [
      '**/test/**/*.{ts,tsx}',
      'e2e/**/*.ts',
      'scripts/**/*.{mjs,ts}',
      'packages/contracts/scripts/**/*.mjs',
    ],
    rules: { 'no-console': 'off', '@typescript-eslint/no-explicit-any': 'off' },
  },
);
