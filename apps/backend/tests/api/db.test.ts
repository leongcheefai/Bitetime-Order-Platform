// tests/api/db.test.ts
// Proves withTransaction() actually commits and actually rolls back.
//
// #65 moves order intake onto this helper: the daily counter, the order row and the voucher
// claim will commit together or not at all, and a failed redemption will abort the order by
// throwing. That design is only sound if a throw inside the callback really does undo the
// writes. Ship the helper without this test and the first caller inherits a rollback nobody
// ever watched work — which is the exact shape of the bug the transaction is there to kill.
import { describe, it, expect, afterAll } from 'vitest'
import type postgres from 'postgres'
import { sql, withTransaction } from '../../src/db.js'

const SLUG = 'txn-probe'

// Either the pool or a transaction-scoped handle. Seeding through the transaction is the
// whole point: seed through `sql` instead and the write is outside it, and the rollback test
// would pass for the wrong reason.
type Handle = postgres.Sql | postgres.TransactionSql

/** Merchants is a convenient real table with a unique slug; nothing here is referral-specific. */
async function merchantExists(slug: string) {
  const rows = await sql<{ n: number }[]>`select count(*)::int as n from merchants where slug = ${slug}`
  return rows[0].n > 0
}

async function seed(slug: string, tx: Handle = sql) {
  await tx`
    insert into merchants (name, slug, order_prefix, status)
    values (${slug}, ${slug}, 'TX', 'active')
  `
}

afterAll(async () => {
  await sql`delete from merchants where slug = ${SLUG}`
})

describe('withTransaction', () => {
  it('commits what the callback wrote when it returns', async () => {
    await withTransaction(async (tx) => { await seed(SLUG, tx) })

    expect(await merchantExists(SLUG)).toBe(true)
    await sql`delete from merchants where slug = ${SLUG}`
  })

  it('rolls back everything the callback wrote when it throws', async () => {
    const boom = new Error('domain rule rejected this')

    await expect(
      withTransaction(async (tx) => {
        await seed(SLUG, tx)
        // The row is visible INSIDE the transaction — so the rollback below is undoing a real
        // write, not passing because the insert never landed.
        const inside = await tx<{ n: number }[]>`select count(*)::int as n from merchants where slug = ${SLUG}`
        expect(inside[0].n).toBe(1)
        throw boom
      }),
    ).rejects.toThrow(boom)

    expect(await merchantExists(SLUG)).toBe(false)
  })

  it('rethrows the callback’s own error, not a driver error', async () => {
    class VoucherAlreadyUsed extends Error {}

    await expect(
      withTransaction(async () => { throw new VoucherAlreadyUsed('already used') }),
    ).rejects.toBeInstanceOf(VoucherAlreadyUsed)
  })

  it('returns the callback’s value on commit', async () => {
    const result = await withTransaction(async () => 'ORDER-0001')

    expect(result).toBe('ORDER-0001')
  })
})
