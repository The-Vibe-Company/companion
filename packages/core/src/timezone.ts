/** Validate the member profile timezone. */
export function isIanaTimeZone(timezone: string): boolean {
  if (!timezone || timezone.length > 100) return false;
  try {
    Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}
