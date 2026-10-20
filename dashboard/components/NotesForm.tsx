'use client';

import { saveTradeNotes } from '@/app/actions';
import { ActionForm, SubmitButton } from './ActionForm';

export default function NotesForm({ tradeId, notes }: { tradeId: number; notes: string | null }) {
  return (
    <ActionForm action={saveTradeNotes} className="form">
      <input type="hidden" name="trade_id" value={tradeId} />
      <textarea name="notes" defaultValue={notes ?? ''} maxLength={4000} aria-label="Trade notes" placeholder="Why did you take this trade? What did you learn?" />
      <div><SubmitButton className="small" pendingText="Saving…">Save notes</SubmitButton></div>
    </ActionForm>
  );
}
