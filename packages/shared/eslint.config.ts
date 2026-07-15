import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
      // Matches apps/frontend and apps/backend, which both disable this rule. The pricing
      // rule carries `as any` casts on the loosely-typed voucher shape (`type`/`value`/`usedBy`
      // reached through PricedVoucher's index signature). Turning the rule on here means
      // rewriting code this workspace deliberately keeps structurally identical to its callers.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
)
