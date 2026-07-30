// Foreground time accumulator for `engagement_time_msec`.
//
// GA4 derives average engagement time, engaged sessions, engagement rate and
// therefore bounce rate from this field. This library used to send a constant
// `100`, which made every one of those metrics wrong rather than merely
// imprecise. gtag.js measures real foreground time between hits and sends it
// as `_et`; this measures the same thing.
//
// The clock arrives as a constructor parameter rather than being read from
// `Date.now()` directly, so this stays free of globals and testable as a table
// — the same reason `deviceFromUserAgent` takes `maxTouchPoints`.

export class EngagementTimer {
    private accumulated = 0;
    private visibleSince: number | null;

    constructor(private readonly now: () => number, visible: boolean) {
        this.visibleSince = visible ? now() : null;
    }

    setVisible(visible: boolean): void {
        if (visible) {
            // Guard against a redundant call: restarting the interval would
            // silently discard the time accrued since it opened.
            if (this.visibleSince === null) {
                this.visibleSince = this.now();
            }
            return;
        }
        if (this.visibleSince !== null) {
            this.accumulated += this.elapsedSince(this.visibleSince);
            this.visibleSince = null;
        }
    }

    /**
     * Milliseconds visible since the last call. Resets, and reopens the interval
     * when still visible, so no time is double-counted or lost across hits.
     */
    consume(): number {
        let total = this.accumulated;
        this.accumulated = 0;
        if (this.visibleSince !== null) {
            total += this.elapsedSince(this.visibleSince);
            this.visibleSince = this.now();
        }
        return total;
    }

    // A clock that jumps backwards would otherwise yield a negative engagement
    // time, which GA4 has no sensible way to store.
    private elapsedSince(start: number): number {
        return Math.max(0, this.now() - start);
    }
}
