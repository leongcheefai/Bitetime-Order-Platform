// Rules that must hold identically in the frontend and the backend. Source-only: both
// workspaces compile TypeScript themselves (Vite/esbuild/Vitest), so there is no build
// step and no dist — the consumers bundle this source directly.
export { MIN_PASSWORD_LENGTH, isPasswordLongEnough } from './password.js'
