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
      // rule carries `as any` casts reaching voucher columns that do not exist yet
      // (minOrder/expiresAt/email) — inert and deliberately left as-is until #71 makes them
      // real. (The promo fields this comment used to cover, promoPrice/promoLimit/promoEnd,
      // are real columns as of #69 and are now declared on PricedProduct, not cast through
      // `any`.) Turning the rule on here means rewriting code this move must not touch.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
)
