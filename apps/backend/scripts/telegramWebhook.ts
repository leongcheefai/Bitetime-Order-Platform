// Register or inspect the support chat webhook, or forward updates to a LOCAL backend.
//
//   telegram:webhook set https://api.example.com   → setWebhook (a HUMAN runs this for production)
//   telegram:webhook info                          → getWebhookInfo
//   telegram:webhook poll [http://localhost:8787]  → getUpdates → POST the local webhook route
//
// Reads process.env directly (loaded by --env-file), NOT src/env.ts: that module requires the
// Stripe variables, which have nothing to do with this.
//
// `poll` is the support chat's `stripe listen`. Telegram refuses getUpdates on a bot with a
// webhook, so poll mode needs a SEPARATE dev bot — and refuses to run on one with a webhook,
// because deleting it would silently stop every merchant's replies in production. The refusal
// rule is pollRefusal() in src/supportChat.ts, which is unit-tested; this file is only I/O.
import { pollRefusal } from '../src/supportChat.js'

const token = process.env.PLATFORM_TG_TOKEN ?? ''
const secret = process.env.PLATFORM_TG_WEBHOOK_SECRET ?? ''

async function tg(method: string, body?: unknown) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const data = (await res.json()) as { ok: boolean; result?: any; description?: string }
  if (!data.ok) throw new Error(`${method}: ${data.description}`)
  return data.result
}

async function poll(target: string) {
  const info = await tg('getWebhookInfo')
  const refusal = pollRefusal(info.url ?? '')
  if (refusal) throw new Error(refusal)
  console.log(`Forwarding updates to ${target}. Ctrl-C stops.`)
  let offset = 0
  for (;;) {
    const updates = (await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] })) as { update_id: number }[]
    for (const u of updates) {
      const res = await fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
        body: JSON.stringify(u),
      }).catch((e) => { console.error('forward failed:', e.message); return null })
      console.log(`update ${u.update_id} → ${res?.status ?? 'no response'}`)
      // Stop at the first update the backend did not take, as Telegram itself would retry it.
      if (!res || res.status >= 500) break
      offset = u.update_id + 1
    }
  }
}

async function main() {
  const usage = 'Usage: telegram:webhook <set <backend-url> | info | poll [target]>'
  const [command, arg] = process.argv.slice(2)
  if (!command) throw new Error(usage)
  if (!token || !secret) throw new Error('Set PLATFORM_TG_TOKEN and PLATFORM_TG_WEBHOOK_SECRET in apps/backend/.env first.')

  if (command === 'set') {
    if (!arg) throw new Error('Usage: telegram:webhook set <backend-url>')
    const url = `${arg.replace(/\/+$/, '')}/api/telegram/support-webhook`
    await tg('setWebhook', { url, secret_token: secret, allowed_updates: ['message'] })
    console.log(`Webhook set: ${url}`)
  } else if (command === 'info') {
    console.log(await tg('getWebhookInfo'))
  } else if (command === 'poll') {
    await poll(`${(arg ?? 'http://localhost:8787').replace(/\/+$/, '')}/api/telegram/support-webhook`)
  } else {
    throw new Error(usage)
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
