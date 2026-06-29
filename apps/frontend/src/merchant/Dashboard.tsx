import { useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { useSession } from '../SessionContext'
import { usePageVariants } from '../motion'
import ProductsManager from './ProductsManager'
import VouchersManager from './VouchersManager'
import ShopSettings from './ShopSettings'
import OrdersView from './OrdersView'
import CustomersView from './CustomersView'

const SECTIONS = [
  { key: 'products',  en: 'Products',  zh: '产品' },
  { key: 'vouchers',  en: 'Vouchers',  zh: '优惠券' },
  { key: 'settings',  en: 'Settings',  zh: '设置' },
  { key: 'orders',    en: 'Orders',    zh: '订单' },
  { key: 'customers', en: 'Customers', zh: '顾客' },
]

export default function Dashboard() {
  const { t, merchant } = useSession()
  const [section, setSection] = useState<string>('products')
  const variants = usePageVariants()
  return (
    <div className="form-wrap form-wrap--wide">
      <div className="mm-dash-header">
        <h1 className="mm-dash-shop-name">{merchant!.name}</h1>
        <p className="mm-store-url">
          {t('Store', '店铺')}:{' '}
          <a href={`/s/${merchant!.slug}`} target="_blank" rel="noopener noreferrer">
            /s/{merchant!.slug}
          </a>
        </p>
      </div>
      <nav className="mm-dash-nav">
        {SECTIONS.map(s => (
          <button
            key={s.key}
            type="button"
            className={`mm-dash-tab${section === s.key ? ' active' : ''}`}
            onClick={() => setSection(s.key)}
          >
            {t(s.en, s.zh)}
          </button>
        ))}
      </nav>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={section} variants={variants} initial="initial" animate="animate" exit="exit">
          {section === 'products'  && <ProductsManager />}
          {section === 'vouchers'  && <VouchersManager />}
          {section === 'settings'  && <ShopSettings />}
          {section === 'orders'    && <OrdersView />}
          {section === 'customers' && <CustomersView />}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
