-- ============================================================================
-- Seed the `settings.main` row so a fresh database boots with a working config.
-- Mirrors DEFAULTS in src/store.js. Idempotent: only inserts if absent.
--
-- Secrets (Telegram token, EmailJS keys) are intentionally left BLANK here —
-- set them via the owner Settings UI (AdminPanel) on each environment instead
-- of committing them to migrations. The client falls back to its own DEFAULTS
-- until this row is populated.
-- ============================================================================
insert into public.settings (key, value)
values (
  'main',
  jsonb_build_object(
    'products', jsonb_build_array(
      jsonb_build_object('id','chewy',  'name','Soft & chewy cookies',  'desc','Classic melt-in-your-mouth goodness', 'price',12,'unit','pc'),
      jsonb_build_object('id','crinkle','name','Crinkle cookies',        'desc','Chewy center with powdery tops',      'price',12,'unit','pc'),
      jsonb_build_object('id','lava',   'name','Stuffed / lava cookies', 'desc','Oozy filling inside every bite',      'price',15,'unit','pc'),
      jsonb_build_object('id','box',    'name','Cookie box / gift set',  'desc','Beautifully packed assortment',       'price',45,'unit','box')
    ),
    'shipping', jsonb_build_object('WM',8,'EM',18),
    'sameday',  jsonb_build_object(
      'enabled',false,'origin','','originLat',null,'originLng',null,
      'base',7,'perKm',1.5,'maxKm',20,
      'slots', jsonb_build_array(
        jsonb_build_object('label','10:00 AM – 12:00 PM','cutoff',10),
        jsonb_build_object('label','1:00 PM – 3:00 PM','cutoff',13),
        jsonb_build_object('label','4:00 PM – 6:00 PM','cutoff',16)
      )
    ),
    'pickup',        jsonb_build_object('address','','hours',''),
    'paymentNote',   '',
    'availableDays', jsonb_build_array(1,2,3,4,5,6),
    'leadDays',      3,
    'blockedDates',  jsonb_build_array(),
    'tgToken','', 'tgChatId','',
    'ejsServiceId','', 'ejsTemplateId','', 'ejsShippingTemplateId','', 'ejsPublicKey',''
  )
)
on conflict (key) do nothing;
