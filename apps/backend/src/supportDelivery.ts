// Merchant → Telegram. The message row is ALREADY stored when this runs, so a failure here costs
// the alert, never the merchant's words. Returns whether the text reached Telegram.
import { claimTopic, clearTopic, setMessageTelegramId } from './supportChatDb.js'
import { topicName, topicHeader, merchantText } from './supportChat.js'
import { TelegramThreadGone, type SupportConfig, type SupportTelegram } from './supportTelegram.js'

export interface DeliverInput {
  merchant: { id: string; name: string; slug: string; status: string }
  /** Read lazily: only a NEW topic's header needs it. */
  ownerEmail: () => Promise<string | null>
  messageId: string
  /** The thread was marked done and this message reopens it — reopen the Telegram topic too. */
  reopen: boolean
  body: string
  images: File[]
  frontendUrl: string
}

export async function deliverMerchantMessage(
  deps: { telegram: SupportTelegram; config: SupportConfig },
  input: DeliverInput,
): Promise<boolean> {
  const { telegram, config } = deps
  const { merchant } = input

  const attempt = async () => {
    const { topicId, created } = await claimTopic(merchant.id, () =>
      telegram.createTopic(config, topicName(merchant.name, merchant.slug)))
    if (created) {
      await telegram.sendText(config, topicId, topicHeader({
        name: merchant.name, slug: merchant.slug, status: merchant.status,
        ownerEmail: await input.ownerEmail(), frontendUrl: input.frontendUrl,
      }))
    } else if (input.reopen) {
      // A failed reopen must not cost the alert: the bot is an admin and can still post into a
      // closed topic, so the message lands either way — only less visibly.
      await telegram.reopenTopic(config, topicId)
        .catch(e => console.error(`support ${input.messageId}: reopenForumTopic failed:`, e?.message ?? e))
    }
    const tgId = await telegram.sendText(config, topicId, merchantText(input.body, input.images.length))
    await setMessageTelegramId(input.messageId, tgId)
    // A lost photo does not un-alert: the text, which says how many follow, already landed.
    for (const image of input.images) {
      await telegram.sendPhoto(config, topicId, image)
        .catch(e => console.error(`support ${input.messageId}: sendPhoto failed:`, e?.message ?? e))
    }
  }

  try {
    await attempt()
    return true
  } catch (e) {
    if (e instanceof TelegramThreadGone) {
      // The topic was deleted by hand. Forget it, make a new one, try once more.
      await clearTopic(merchant.id, e.topicId)
      try {
        await attempt()
        return true
      } catch (e2: any) {
        console.error(`support ${input.messageId}: retry after a lost topic failed:`, e2?.message ?? e2)
        return false
      }
    }
    console.error(`support ${input.messageId}: Telegram delivery failed:`, (e as any)?.message ?? e)
    return false
  }
}
