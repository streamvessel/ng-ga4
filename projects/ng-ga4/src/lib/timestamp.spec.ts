import { clampToNow, isWithinBackdateWindow, MP_MAX_EVENT_AGE_MS, toTimestampMicros } from './timestamp';

describe('timestamp', () => {
    const NOW = 1700000000000;

    it('converts epoch milliseconds to whole microseconds', () => {
        expect(toTimestampMicros(NOW)).toBe(NOW * 1000);
        expect(Number.isSafeInteger(toTimestampMicros(NOW))).toBeTrue();
    });

    it('rounds a fractional millisecond rather than emitting a fractional microsecond count', () => {
        expect(toTimestampMicros(NOW + 0.6)).toBe((NOW + 1) * 1000);
    });

    it('keeps an event exactly 72 hours old', () => {
        expect(isWithinBackdateWindow(toTimestampMicros(NOW - MP_MAX_EVENT_AGE_MS), NOW)).toBeTrue();
    });

    it('rejects an event a millisecond past 72 hours old', () => {
        expect(isWithinBackdateWindow(toTimestampMicros(NOW - MP_MAX_EVENT_AGE_MS - 1), NOW)).toBeFalse();
    });

    it('treats a future timestamp as within the window', () => {
        expect(isWithinBackdateWindow(toTimestampMicros(NOW + 5000), NOW)).toBeTrue();
    });

    it('clamps a future timestamp to now and leaves a past one alone', () => {
        expect(clampToNow(toTimestampMicros(NOW + 5000), NOW)).toBe(toTimestampMicros(NOW));
        expect(clampToNow(toTimestampMicros(NOW - 5000), NOW)).toBe(toTimestampMicros(NOW - 5000));
    });
});
