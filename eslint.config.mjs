// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      // The codebase deliberately does not enforce any-safety: Prisma
      // error metas, JWT payloads, provider SDK responses, and test
      // doubles are `any`-shaped throughout, and no-explicit-any was
      // already off for the same reason. The no-unsafe-* family is the
      // same gate in four pieces — turning it on would mean rewriting
      // hundreds of correct call sites for zero runtime change. Kept off
      // as one coherent, documented stance rather than half-enforced.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      // Async signatures without an await are normal here: interface-
      // required mocks (card/KYC/screening/OTP providers), Passport's
      // validate(), and test doubles must match an async contract they
      // resolve synchronously.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-floating-promises': 'error',
      // Destructuring-to-omit is how sensitive columns (pin, encrypted
      // BVN/NIN) are stripped before a user record leaves the server —
      // the omitted names are the point of the pattern, not dead code.
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
);