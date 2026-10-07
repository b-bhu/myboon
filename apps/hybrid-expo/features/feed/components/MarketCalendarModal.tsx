import { MarketCalendar } from './market-calendar';

// Kept for existing callers; all schedules now come from the calendar API.
export function MarketCalendarModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  return visible ? <MarketCalendar initiallyExpanded inline={false} onClose={onClose} /> : null;
}
