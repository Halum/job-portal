// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/drizzle/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  // Deliberately the non-type-checked ruleset: type-aware linting requires
  // every linted file to belong to a tsconfig "include" (fighting test
  // files, root-level configs, etc.), which is more friction than value for
  // this project's size. tsc -b already gives us full type checking.
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'warn',
    },
  },
  eslintConfigPrettier,
);
