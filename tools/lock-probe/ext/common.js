// Loaded by the worker and by each probe page. Listens on a BroadcastChannel:
//   go      - optionally hide Web Locks in this context, run probeMint[fn](), report the ID
//   hold    - take the client-ID lock and keep it until 'release'
//   try     - ask for the client-ID lock with ifAvailable and report whether it was granted
const ctxName = typeof window === 'undefined'
  ? 'worker'
  : (new URLSearchParams(location.search).get('ctx') || 'page');
const realLocks = navigator.locks;
const LOCK = 'ng-ga4:client-id';
const bc = new BroadcastChannel('probe');
let release = null;

bc.onmessage = async (e) => {
  const m = e.data;
  if (m.cmd === 'go' && m.callers[ctxName]) {
    Object.defineProperty(navigator, 'locks', { value: m.useLocks ? realLocks : undefined, configurable: true });
    let id = null;
    let error = null;
    try {
      id = await self.probeMint[m.callers[ctxName]]();
    } catch (err) {
      error = String(err);
    }
    bc.postMessage({ cmd: 'result', run: m.run, ctx: ctxName, id, error });
  } else if (m.cmd === 'hold' && m.ctx === ctxName) {
    realLocks.request(LOCK, () => new Promise((resolve) => {
      release = resolve;
      bc.postMessage({ cmd: 'holding', ctx: ctxName });
    }));
  } else if (m.cmd === 'release' && release) {
    release();
    release = null;
  } else if (m.cmd === 'try' && m.ctx === ctxName) {
    const acquired = await realLocks.request(LOCK, { ifAvailable: true }, (lock) => lock !== null);
    const state = await realLocks.query();
    bc.postMessage({ cmd: 'tried', ctx: ctxName, acquired, held: state.held.map((h) => h.name) });
  } else if (m.cmd === 'ping') {
    bc.postMessage({ cmd: 'pong', ctx: ctxName });
  }
};
