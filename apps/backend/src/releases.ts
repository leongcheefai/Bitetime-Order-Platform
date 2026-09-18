// Rewrites a raw GitHub release body into merchant-facing copy for the dashboard's "what's
// new" bell (#163). See docs/superpowers/specs/2026-08-05-github-release-notes-design.md.
//
// Pure adapter, shaped like github.ts's createGithubIssue: the API key is a PARAMETER, never
// read from env.ts, and this file imports nothing from supabase.ts/db.ts — that is what lets
// it be imported by a unit test with zero env vars set. The DB side (releasesDb.ts) is a
// separate file for the same reason shopCustomersDb.ts is split from shopCustomers.ts.
//
// Best-effort: swallows its own errors and returns null rather than throwing. A Claude outage
// must never break the pull action, only leave a release without a summary.
import Anthropic from '@anthropic-ai/sdk'

export interface HumanizedRelease {
  title: string
  summary: string
}

export type HumanizeRelease = (
  apiKey: string,
  input: { tag: string; name: string; body: string },
) => Promise<HumanizedRelease | null>

function buildPrompt(input: { tag: string; name: string; body: string }): string {
  return `You are writing a "what's new" note for a food-ordering platform's merchants — small business owners, not developers. Rewrite this GitHub release into copy they can scan in ten seconds, not a paragraph they have to read start to finish.

Release: ${input.name} (${input.tag})

Raw release notes (from GitHub, written for developers — pull request titles, links, technical jargon):
${input.body}

Write:
- "title": a short, plain-language headline (under 60 characters), no version numbers or PR references.
- "summary": markdown, grouped under whichever of these headings actually apply — omit any heading with nothing merchant-visible in this release:
### New features
### Fixes
### Improvements

Each heading is followed by a plain bullet list ("- " prefix), one short line per item, written for what the merchant can now do or what changed for them — never a PR title, an internal refactor, or a test/dependency change unless it fixed a bug merchants would have noticed.

Leave out anything that only the platform's own staff see or use: the superadmin, the /admin dashboard, admin-only tools, platform alerts and notifications to the platform team, moderation, release tooling, CI, deployment and internal operations. A merchant never sees those, so they are not news to a merchant. If a release truly has nothing merchant-visible, use a single heading that fits best (usually ### Improvements) with one bullet saying so plainly. Always use headings and bullets — never a prose paragraph, even for a single change.

Write in plain English. No links, no PR/issue numbers, no version numbers inside the bullets.`
}

const RELEASE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['title', 'summary'],
  additionalProperties: false,
} as const

export const humanizeRelease: HumanizeRelease = async (apiKey, input) => {
  if (!apiKey) {
    console.error(`Release humanization skipped for ${input.tag}: no Anthropic API key configured`)
    return null
  }
  try {
    const client = new Anthropic({ apiKey })
    const response = await client.messages.create({
      // Haiku, not Opus: this is a rewrite of text that already exists, not a reasoning task,
      // and the pull is a superadmin waiting on a button. Haiku 4.5 does NOT accept the
      // `effort` parameter — it 400s — so `output_config` carries the schema only. It also
      // does no thinking unless asked, which is the other half of why it is quick here.
      model: 'claude-haiku-4-5',
      // `max_tokens` bounds the whole response. 4096 is well clear of a few-hundred-token
      // summary; at the old 1024 a long release body could return truncated JSON, which
      // `JSON.parse` throws on — recorded as a humanize_error that looks like an outage.
      max_tokens: 4096,
      output_config: {
        format: { type: 'json_schema', schema: RELEASE_SCHEMA },
      },
      messages: [{ role: 'user', content: buildPrompt(input) }],
    })

    if (response.stop_reason === 'max_tokens') {
      console.error(`Release humanization for ${input.tag} ran out of tokens`)
      return null
    }

    if (response.stop_reason === 'refusal') {
      console.error(`Release humanization refused for ${input.tag}`)
      return null
    }

    const block = response.content.find((b) => b.type === 'text')
    if (!block || block.type !== 'text') {
      console.error(`Release humanization for ${input.tag} returned no text content`)
      return null
    }

    const parsed = JSON.parse(block.text) as HumanizedRelease
    if (!parsed.title || !parsed.summary) {
      console.error(`Release humanization for ${input.tag} returned an incomplete result`)
      return null
    }
    return parsed
  } catch (e) {
    console.error(`Release humanization failed for ${input.tag}:`, e instanceof Error ? e.message : String(e))
    return null
  }
}
