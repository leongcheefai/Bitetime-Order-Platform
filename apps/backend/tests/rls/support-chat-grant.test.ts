// tests/rls/support-chat-grant.test.ts
// Belt on top of the code path: the browser cannot read the support chat directly, in either
// table or in the bucket. If a SELECT here ever returns rows, a grant crept back and the API is
// no longer the only door. Mirrors trial-feedback-grant.test.ts.
import { describe, it, expect } from 'vitest'
import { anonClient, makeUser, seedMerchant, serviceClient, resetMerchant } from './helpers.js'

function expectDenied(error: { code?: string; message: string } | null) {
  expect(error).not.toBeNull()
  expect(error?.code === '42501' || error?.message.toLowerCase().includes('permission denied')).toBe(true)
}

describe('support chat is not directly readable by the browser', () => {
  it('denies anonymous SELECTs on both tables', async () => {
    const threads = await anonClient().from('support_threads').select('*')
    expectDenied(threads.error)
    const messages = await anonClient().from('support_messages').select('*')
    expectDenied(messages.error)
  })

  it('denies the shop owner a SELECT on both tables and a download from the bucket', async () => {
    await resetMerchant('support-grant-shop')
    const owner = await makeUser('support-grant-owner@example.com', 'password123')
    const { data: session } = await owner.auth.getSession()
    const merchantId = await seedMerchant({ slug: 'support-grant-shop', owner_id: session.session!.user.id })

    const svc = serviceClient()
    const t = await svc.from('support_threads').insert({ merchant_id: merchantId })
    if (t.error) throw new Error(`seeding support_threads: ${t.error.message}`)
    const m = await svc.from('support_messages')
      .insert({ merchant_id: merchantId, sender: 'merchant', body: 'hello' }).select('id').single()
    if (m.error) throw new Error(`seeding support_messages: ${m.error.message}`)
    const path = `${merchantId}/${m.data.id}/a.png`
    const up = await svc.storage.from('support-images')
      .upload(path, new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), { upsert: true })
    if (up.error) throw new Error(`seeding support-images: ${up.error.message}`)

    expectDenied((await owner.from('support_threads').select('*').eq('merchant_id', merchantId)).error)
    expectDenied((await owner.from('support_messages').select('*').eq('merchant_id', merchantId)).error)
    const dl = await owner.storage.from('support-images').download(path)
    expect(dl.data).toBeNull()
  })
})
