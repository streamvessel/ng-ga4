import { EngagementTimer } from './engagement-timer';

describe('EngagementTimer', () => {
    let now: number;
    const clock = () => now;

    beforeEach(() => {
        now = 1000;
    });

    it('accumulates time while visible', () => {
        const timer = new EngagementTimer(clock, true);
        now = 4000;

        expect(timer.consume()).toBe(3000);
    });

    it('accumulates nothing when constructed hidden', () => {
        const timer = new EngagementTimer(clock, false);
        now = 4000;

        expect(timer.consume()).toBe(0);
    });

    it('stops accumulating while hidden and resumes when shown', () => {
        const timer = new EngagementTimer(clock, true);
        now = 3000;
        timer.setVisible(false);
        now = 9000;              // hidden for 6s — must not count
        timer.setVisible(true);
        now = 11000;             // visible again for 2s

        expect(timer.consume()).toBe(4000);
    });

    // consume() resets, so the next hit reports time since the previous hit —
    // the same semantic as gtag's _et. A running total would multiply-count the
    // same seconds across every event in a session.
    it('resets on consume and keeps counting when still visible', () => {
        const timer = new EngagementTimer(clock, true);
        now = 3000;
        expect(timer.consume()).toBe(2000);

        now = 3500;
        expect(timer.consume()).toBe(500);
    });

    it('reports zero for back-to-back consumes', () => {
        const timer = new EngagementTimer(clock, true);
        now = 3000;
        timer.consume();

        expect(timer.consume()).toBe(0);
    });

    it('folds the open interval in when hidden, and consume after that adds nothing', () => {
        const timer = new EngagementTimer(clock, true);
        now = 2500;
        timer.setVisible(false);
        now = 8000;

        expect(timer.consume()).toBe(1500);
        expect(timer.consume()).toBe(0);
    });

    it('ignores a redundant setVisible(true)', () => {
        const timer = new EngagementTimer(clock, true);
        now = 2000;
        timer.setVisible(true);   // already visible — must not restart the interval
        now = 3000;

        expect(timer.consume()).toBe(2000);
    });

    it('ignores a redundant setVisible(false)', () => {
        const timer = new EngagementTimer(clock, true);
        now = 2000;
        timer.setVisible(false);
        now = 5000;
        timer.setVisible(false);

        expect(timer.consume()).toBe(1000);
    });

    // A clock that jumps backwards (NTP correction, or a test that rewinds) must
    // not produce a negative engagement time — GA4 would reject or mis-store it.
    it('never returns a negative value', () => {
        const timer = new EngagementTimer(clock, true);
        now = 500;

        expect(timer.consume()).toBe(0);
    });
});
