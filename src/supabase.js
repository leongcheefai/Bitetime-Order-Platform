import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL ?? 'https://wthglouiidzyljzcprku.supabase.co',
  import.meta.env.VITE_SUPABASE_KEY ?? 'sb_publishable_NyCkzEy6HO_H67Gk_xE6jg_Oe6VP1Xt'
);
