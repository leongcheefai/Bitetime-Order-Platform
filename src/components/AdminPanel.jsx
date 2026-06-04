import { useState } from 'react';
import { DEFAULTS, saveSettingsToDB } from '../store';

export default function AdminPanel({ settings, onSave, lang }) {
  const t = (en, zh) => lang === 'zh' ? zh : en;
  const [products, setProducts] = useState(() => JSON.parse(JSON.stringify(settings.products)));
  const [wmFee, setWmFee] = useState(settings.shipping.WM);
  const [emFee, setEmFee] = useState(settings.shipping.EM);
  const [tgToken, setTgToken] = useState(settings.tgToken);
  const [tgChatId, setTgChatId] = useState(settings.tgChatId);
  const [saveMsg, setSaveMsg] = useState('');

  function updateProduct(i, field, value) {
    const updated = [...products];
    updated[i] = { ...updated[i], [field]: value };
    setProducts(updated);
  }

  function addProduct() {
    setProducts([...products, { id: 'item_' + Date.now(), name: '', desc: '', price: 0, unit: 'pc' }]);
  }

  function deleteProduct(i) {
    if (products.length <= 1) { alert(t('You need at least one product!', '至少需要一个产品！')); return; }
    setProducts(products.filter((_, idx) => idx !== i));
  }

  function handleSave() {
    console.log('[AdminPanel] handleSave clicked, products:', JSON.stringify(products));
    try {
      for (const p of products) {
        if (!p.name || !p.name.trim()) {
          console.log('[AdminPanel] Validation failed - empty name for product:', p);
          setSaveMsg(t('⚠ Please fill in all product names.', '⚠ 请填写所有产品名称。'));
          return;
        }
      }
      const newSettings = {
        products,
        shipping: { WM: parseFloat(wmFee) || 0, EM: parseFloat(emFee) || 0 },
        tgToken: tgToken.trim() || DEFAULTS.tgToken,
        tgChatId: tgChatId.trim() || DEFAULTS.tgChatId,
      };
      console.log('[AdminPanel] Saving settings:', JSON.stringify(newSettings));
      saveSettingsToDB(newSettings);
      onSave(newSettings);
      setSaveMsg(t('✓ Saved!', '✓ 已保存！'));
      setTimeout(() => setSaveMsg(''), 2500);
    } catch (err) {
      console.error('[AdminPanel] Save error:', err);
      setSaveMsg('⚠ Error: ' + err.message);
    }
  }

  return (
    <div className="admin-panel">
      <div className="admin-title"><span>✏️</span> {t('Menu Editor', '菜单编辑器')}</div>

      <div className="admin-section">
        <div className="admin-section-label">{t('Products', '产品')}</div>
        <div className="product-row-header">
          <span>{t('Name', '名称')}</span>
          <span className="desc-head">{t('Description', '描述')}</span>
          <span>{t('Unit', '单位')}</span>
          <span>{t('Price (RM)', '价格 (RM)')}</span>
          <span></span>
        </div>
        <div className="product-list">
          {products.map((p, i) => (
            <div className="product-row" key={p.id}>
              <input type="text" value={p.name} placeholder="Product name" onChange={e => updateProduct(i, 'name', e.target.value)} />
              <input type="text" className="desc-input" value={p.desc} placeholder="Description" onChange={e => updateProduct(i, 'desc', e.target.value)} />
              <input type="text" className="unit-input" value={p.unit} placeholder="pc" onChange={e => updateProduct(i, 'unit', e.target.value)} />
              <input type="number" className="price-input" value={p.price} min="0" step="0.50" onChange={e => updateProduct(i, 'price', parseFloat(e.target.value) || 0)} />
              <button className="del-btn" onClick={() => deleteProduct(i)} title="Remove">×</button>
            </div>
          ))}
        </div>
        <button className="add-btn" onClick={addProduct}>{t('+ Add product', '+ 添加产品')}</button>
      </div>

      <div className="admin-section">
        <div className="admin-section-label">{t('Delivery fees', '送货费')}</div>
        <div className="admin-fields">
          <div className="admin-field">
            <label>{t('West Malaysia (WM) — RM', '西马来西亚 (WM) — RM')}</label>
            <input type="number" min="0" value={wmFee} onChange={e => setWmFee(e.target.value)} />
          </div>
          <div className="admin-field">
            <label>{t('East Malaysia / Sabah / Sarawak (EM) — RM', '东马来西亚 / 沙巴 / 砂拉越 (EM) — RM')}</label>
            <input type="number" min="0" value={emFee} onChange={e => setEmFee(e.target.value)} />
          </div>
        </div>
      </div>

      <div className="admin-section">
        <div className="admin-section-label">Telegram Bot Settings</div>
        <div className="admin-fields">
          <div className="admin-field full">
            <label style={{ fontSize: '12px', color: '#A07070', marginBottom: '2px' }}>Bot Token (from @BotFather)</label>
            <input type="text" placeholder="123456789:AAFxxxxxxxxxxxxxxx" value={tgToken} onChange={e => setTgToken(e.target.value)} />
          </div>
          <div className="admin-field full">
            <label style={{ fontSize: '12px', color: '#A07070', marginBottom: '2px' }}>Your Chat ID (from @userinfobot)</label>
            <input type="text" placeholder="123456789" value={tgChatId} onChange={e => setTgChatId(e.target.value)} />
          </div>
        </div>
      </div>

      <button className="save-btn" onClick={handleSave}>{t('💾 Save changes', '💾 保存更改')}</button>
      <p className="save-msg">{saveMsg}</p>
    </div>
  );
}
