// Foreground time accumulator for `engagement_time_msec`.
//
// GA4 derives average engagement time, engaged sessions, engagement rate and
// therefore bounce rate from this field. This library used to send a constant
// `100`, which made every one of those metrics wrong rather than merely
// imprecise. gtag.js measures real foreground time between hits and sends it
// as `_et`; this measures the same thing.
//
// "Engaged" here means visible *and* focused — GA4 defines engagement as time
// the page is in focus, not merely time it is visible, and stops the clock
// the moment focus moves to another window or application even if the tab
// itself stays visible. The caller is responsible for combining those two
// signals; this class only tracks open/closed spans of whatever it is told.
//
// The clock arrives as a constructor parameter rather than being read from
// `Date.now()` directly, so tests can advance it between calls to simulate
// a live, controllable clock — the only way to unit-test interval accumulation.

export class EngagementTimer {
    private accumulated = 0;
    private engagedSince: number | null;

    constructor(private readonly now: () => number, engaged: boolean) {
        this.engagedSince = engaged ? now() : null;
    }

    setEngaged(engaged: boolean): void {
        if (engaged) {
            // Guard against a redundant call: restarting the interval would
            // silently discard the time accrued since it opened.
            if (this.engagedSince === null) {
                this.engagedSince = this.now();
            }
            return;
        }
        if (this.engagedSince !== null) {
            this.accumulated += this.elapsedSince(this.engagedSince);
            this.engagedSince = null;
        }
    }

    /**
     * Milliseconds engaged since the last call. Resets, and reopens the interval
     * when still engaged, so no time is double-counted or lost across hits.
     */
    consume(): number {
        let total = this.accumulated;
        this.accumulated = 0;
        if (this.engagedSince !== null) {
            total += this.elapsedSince(this.engagedSince);
            this.engagedSince = this.now();
        }
        return total;
    }

    // A clock that jumps backwards would otherwise yield a negative engagement
    // time, which GA4 has no sensible way to store.
    private elapsedSince(start: number): number {
        return Math.max(0, this.now() - start);
    }
}
