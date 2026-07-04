// Shared domain types for the frontend.
//
// Pragmatic strict: Supabase row shapes are NOT generated from the DB schema, so
// each row type names the fields the app relies on and keeps an `[key: string]: any`
// index signature for the rest. That index signature is the deliberate "DB boundary"
// escape hatch the migration plan allows — it keeps dynamic field access from
// erroring without forcing a full generated-types pass.

import type { User } from '@supabase/supabase-js'

export type Lang = 'en' | 'zh'
export type Role = 'customer' | 'merchant' | 'superadmin'
export type MerchantStatus = 'pending' | 'active' | 'suspended'
export type OrderStatus = 'new' | 'preparing' | 'ready' | 'completed' | 'cancelled'

export type Translate = (en: string, zh?: string) => string

export interface Merchant {
  id: string
  name: string
  slug: string
  status: MerchantStatus
  order_prefix?: string
  owner_id?: string
  plan?: string
  billing_cycle?: string
  currency?: string
  pickup_address?: string
  created_at?: string
  [key: string]: any
}

export interface Profile {
  id: string
  name?: string
  email?: string
  app_role?: Role
  merchant_id?: string | null
  email_confirmed?: boolean
  referral_code?: string
  delivery_address?: any
  created_at?: string
  [key: string]: any
}

export interface Product {
  id: string
  merchant_id?: string
  name: string
  name_zh?: string
  desc?: string
  description?: string
  price: number
  unit?: string
  unit_quantity?: number  // display-only quantity paired with unit; defaults to 1
  sort?: number
  image_urls?: string[]
  created_at?: string
  [key: string]: any
}

export interface OrderItem {
  id: string
  name?: string
  qty: number
  price?: number
  unit?: string
  [key: string]: any
}

export interface Order {
  id?: string
  order_number?: string
  merchant_id?: string
  customer_name?: string
  customer_wa?: string
  user_id?: string | null
  mode?: string
  address?: any
  shipping_fee?: number
  items?: OrderItem[]
  total?: number
  currency?: string
  status?: OrderStatus | string
  created_at?: string
  [key: string]: any
}

export interface Voucher {
  code: string
  used?: boolean
  usedBy?: string[]
  maxUses?: number | string | null
  [key: string]: any
}

// Settings is a loose bag — shape varies and parts are persisted as JSON.
export type Settings = Record<string, any>

export interface SessionValue {
  account: User | null | undefined
  profile: Profile | null
  role: Role
  merchant: Merchant | null
  ownMerchant: Merchant | null
  impersonating: boolean
  impersonate: (slug: string) => Promise<Merchant | null>
  stopImpersonating: () => void
  loading: boolean
  lang: Lang
  setLang: (lang: Lang) => void
  t: Translate
  refreshProfile: () => void
  refreshMerchant: () => Promise<void>
}

export interface MerchantState {
  slug?: string | null
  merchant: Merchant | null
  loading: boolean
  notFound: boolean
}
