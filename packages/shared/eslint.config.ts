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
      // rule moved here carries `as any` casts that reach columns which do not exist yet
      // (promoPrice/promoLimit/promoEnd, and voucher minOrder/expiresAt/email). They are
      // inert and deliberately left as-is — #69/#70 make the promo columns real, #71 the
      // voucher ones. Turning the rule on here means rewriting code this move must not touch.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
)
