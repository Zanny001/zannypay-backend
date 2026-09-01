// Was previously duplicated as a private method inside
// RecurringTransfersService only — every other service that needed to
// show a Naira amount in a notification/email body was either not doing
// so at all, or would have reinvented it slightly differently. Pulled out
// once so AdminService, TransactionsService, and anything else that
// formats money for a human-facing message stays byte-for-byte consistent.
export function formatNaira(amount: number): string {
  return `₦${amount.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
