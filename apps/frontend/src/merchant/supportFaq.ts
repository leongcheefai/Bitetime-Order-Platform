// The support panel's fixed FAQ. Data, not markup, so a copy change never touches layout — the
// same split as marketing/faq.ts. A merchant taps a question; nothing here matches free text.
// supportFaq.test.ts pins both languages, unique ids and that every link targets a real section.

export interface Bilingual { en: string; zh: string }

export interface FaqItem {
  id: string
  q: Bilingual
  a: Bilingual
  /** A dashboard section (and Settings sub-tab) the answer points to. */
  link?: { section: string; sub?: string; label: Bilingual }
}

export interface FaqGroup {
  id: string
  title: Bilingual
  items: FaqItem[]
}

export const SUPPORT_FAQ: FaqGroup[] = [
  {
    id: 'orders',
    title: { en: 'Orders', zh: '订单' },
    items: [
      {
        id: 'orders-notify',
        q: { en: 'How do I hear about a new order?', zh: '有新订单时我怎么知道？' },
        a: {
          en: 'Every shop gets an email for each new order. You can also connect your own Telegram bot, and then your phone buzzes for every order too.',
          zh: '每个店铺都会在有新订单时收到邮件。你也可以连接自己的 Telegram 机器人，这样每张订单手机都会提醒你。',
        },
        link: { section: 'settings', sub: 'notifications', label: { en: 'Open Notifications', zh: '打开通知设置' } },
      },
      {
        id: 'orders-number',
        q: { en: 'What does an order number mean?', zh: '订单号是什么意思？' },
        a: {
          en: 'An order number is your shop prefix, the date (YYMMDD), then a daily counter. The counter starts at 50 each day.',
          zh: '订单号由店铺前缀、日期（年月日）和每日序号组成。每天的序号从 50 开始。',
        },
      },
    ],
  },
  {
    id: 'billing',
    title: { en: 'Billing', zh: '账单' },
    items: [
      {
        id: 'billing-trial',
        q: { en: 'How does the free trial work?', zh: '免费试用怎么运作？' },
        a: {
          en: 'Every new shop gets a 7-day free trial. You do not need a card to start. Add a card before the trial ends to keep your shop open.',
          zh: '每个新店铺都有 7 天免费试用，开始时不需要信用卡。请在试用结束前添加信用卡，店铺才会继续营业。',
        },
        link: { section: 'settings', sub: 'subscription', label: { en: 'Open Subscription', zh: '打开订阅' } },
      },
      {
        id: 'billing-price',
        q: { en: 'How much does TinyOrder cost?', zh: 'TinyOrder 收费多少？' },
        a: {
          en: 'One plan, RM39.90 a month. You can also pay yearly.',
          zh: '只有一个方案，每月 RM39.90。你也可以按年付费。',
        },
        link: { section: 'settings', sub: 'subscription', label: { en: 'Open Subscription', zh: '打开订阅' } },
      },
    ],
  },
  {
    id: 'storefront',
    title: { en: 'Storefront', zh: '店面' },
    items: [
      {
        id: 'storefront-arrange',
        q: { en: 'How do I change the order of my products?', zh: '怎么调整产品的顺序？' },
        a: {
          en: 'Open the Storefront section. Drag a section or a product to a new position. The storefront shows the same order.',
          zh: '打开“店面”栏目，把分类或产品拖到新的位置。店面会按同样的顺序显示。',
        },
        link: { section: 'storefront', label: { en: 'Open Storefront', zh: '打开店面' } },
      },
      {
        id: 'storefront-colour',
        q: { en: 'Can I use my own brand colour?', zh: '可以用自己的品牌颜色吗？' },
        a: {
          en: 'Yes. Pick a colour in Settings → Brand. TinyOrder adjusts the shades so that all text stays easy to read.',
          zh: '可以。在“设置 → 品牌”里选择颜色。TinyOrder 会自动调整深浅，让文字始终清楚易读。',
        },
        link: { section: 'settings', sub: 'brand', label: { en: 'Open Brand', zh: '打开品牌设置' } },
      },
    ],
  },
  {
    id: 'account',
    title: { en: 'Account', zh: '账户' },
    items: [
      {
        id: 'account-devices',
        q: { en: 'Why did I get signed out on another device?', zh: '为什么另一台设备被登出了？' },
        a: {
          en: 'A merchant account can stay signed in on 2 devices. When you sign in on a third, the device you used least recently signs out.',
          zh: '一个商家账户最多可以在 2 台设备上保持登录。在第三台设备登录时，最久没用的那台会被登出。',
        },
        link: { section: 'settings', sub: 'devices', label: { en: 'Open Devices', zh: '打开设备' } },
      },
    ],
  },
]
