import { useState } from 'react'
import { useSession } from '../SessionContext'
import ProductsManager from './ProductsManager'
import ShopSettings from './ShopSettings'

const SECTIONS = [
  { key: 'products', en: 'Products', zh: '产品' },
  { key: 'settings', en: 'Settings', zh: '设置' },
]

export default function Dashboard() {
  const { t, merchant } = useSession()
  const [section, setSection] = useState('products')
  return (
    <div style={{ padding: 24, maxWidth: 880 }}>
      <h2>{merchant.name}</h2>
      <p style={{ color:'#888' }}>{t('Store','店铺')}: <a href={`/s/${merchant.slug}`}>/s/{merchant.slug}</a></p>
      <nav style={{ display:'flex', gap:12, margin:'12px 0', borderBottom:'1px solid #eee', paddingBottom:8 }}>
        {SECTIONS.map(s => (
          <button key={s.key} onClick={() => setSection(s.key)}
            style={{ fontWeight: section===s.key ? 700 : 400 }}>{t(s.en, s.zh)}</button>
        ))}
        <span style={{ color:'#bbb' }}>{t('Orders','订单')} ({t('P5','P5')})</span>
        <span style={{ color:'#bbb' }}>{t('Customers','顾客')} ({t('P5','P5')})</span>
      </nav>
      {section === 'products' && <ProductsManager />}
      {section === 'settings' && <ShopSettings />}
    </div>
  )
}
