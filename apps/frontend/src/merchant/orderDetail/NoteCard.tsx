import { useSession } from '../../SessionContext'
import { Textarea } from '@/components/ui/textarea'
import DrawerCard, { CardSaveButton } from './DrawerCard'

/** The merchant's own note on the order. Read-only for a suspended shop. */
export default function NoteCard({
  note,
  saved,
  onChange,
  onSave,
  saving,
  dirty,
  readOnly,
}: {
  note: string
  saved: string | null
  onChange: (v: string) => void
  onSave: () => void
  saving: boolean
  dirty: boolean
  readOnly: boolean
}) {
  const { t } = useSession()

  if (readOnly) {
    // A suspended shop with no note has nothing to show and no way to write one.
    if (!saved) return null
    return (
      <DrawerCard title={t('Note', '备注')}>
        <p className="text-[13px] text-foreground break-words whitespace-pre-wrap">{saved}</p>
      </DrawerCard>
    )
  }

  return (
    <DrawerCard
      title={t('Note', '备注')}
      footer={
        <CardSaveButton
          label={t('Save note', '保存备注')}
          savingLabel={t('Saving…', '保存中…')}
          saving={saving}
          dirty={dirty}
          onSave={onSave}
        />
      }
    >
      <Textarea
        value={note}
        onChange={e => onChange(e.target.value)}
        rows={3}
        aria-label={t('Order note', '订单备注')}
        placeholder={t('Add a note for this order…', '为此订单添加备注…')}
        className="text-[13px] bg-background border-border resize-none"
      />
    </DrawerCard>
  )
}
