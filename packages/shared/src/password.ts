// The customer password rule, in one place.
//
// It has to hold on both sides of the wire and they are separate workspaces: the panel
// rejects a short password before it spends a request, and the backend rejects it before
// it creates an account (Supabase's own floor is 6, which is lower than ours). Two copies
// of the number would drift silently — a panel that accepts what the endpoint refuses is
// a customer stuck at checkout with no idea why.
export const MIN_PASSWORD_LENGTH = 8

export function isPasswordLongEnough(password: string): boolean {
  return password.length >= MIN_PASSWORD_LENGTH
}
