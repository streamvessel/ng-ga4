#!/usr/bin/env node
// Two-context MV3 test for the client-ID lock (#51). See README.md.
// Usage: node run.js [runs-per-arm]   (default 200)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');
const { pathToFileURL } = require('url');

const esbuild = require('esbuild');
const { chromium } = require('playwright');

const HERE = __dirname;
const EXT = path.join(HERE, 'ext');
const ROOT = path.resolve(HERE, '../..');
const RUNS = Number(process.argv[2] || 200);

// Babel and the Angular linker come from the root install (`pnpm install`).
const rootRequire = createRequire(path.join(ROOT, 'package.json'));
const cliRequire = createRequire(rootRequire.resolve('@angular/compiler-cli/package.json'));
const babel = cliRequire('@babel/core');

// Links Angular's partial declarations at build time; the runtime JIT needs
// `new Function`, which an extension page's CSP forbids.
function angularLinkerPlugin(linkerBabelPlugin) {
    return {
        name: 'angular-linker',
        setup(build) {
            build.onLoad({ filter: /[\\/]node_modules[\\/].*\.m?js$/ }, async (args) => {
                const code = await fs.promises.readFile(args.path, 'utf8');
                if (!code.includes('ɵɵngDeclare')) {
                    return undefined;
                }
                const result = await babel.transformAsync(code, {
                    filename: args.path,
                    babelrc: false,
                    configFile: false,
                    compact: false,
                    sourceMaps: false,
                    plugins: [linkerBabelPlugin]
                });
                return { contents: result.code, loader: 'js' };
            });
        }
    };
}

async function build() {
    const linkerPath = rootRequire.resolve('@angular/compiler-cli/linker/babel');
    const linker = await import(pathToFileURL(linkerPath).href);
    const common = {
        bundle: true,
        format: 'iife',
        target: 'es2022',
        logLevel: 'warning',
        tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
        plugins: [angularLinkerPlugin(linker.default)]
    };
    await esbuild.build({ ...common, entryPoints: [path.join(HERE, 'entry-worker.ts')], outfile: path.join(EXT, 'worker.bundle.js') });
    await esbuild.build({ ...common, entryPoints: [path.join(HERE, 'entry-page.ts')], outfile: path.join(EXT, 'page.bundle.js') });
}

// Which caller each context runs: seedNgGa4ClientId() or NgGa4Service.init().
const ARMS = [
    { name: 'seed (worker) vs seed (page)', callers: { worker: 'seed', page: 'seed' } },
    { name: 'seed (worker) vs service (page)', callers: { worker: 'seed', page: 'service' } },
    { name: 'service (page) vs service (page2)', callers: { page: 'service', page2: 'service' } },
    { name: 'seed (worker) vs service (page) vs service (page2)', callers: { worker: 'seed', page: 'service', page2: 'service' } }
];

async function main() {
    await build();

    const profile = fs.mkdtempSync(path.join(HERE, 'profile-'));
    const context = await chromium.launchPersistentContext(profile, {
        headless: true,
        channel: 'chromium',
        args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
    });
    try {
        let [worker] = context.serviceWorkers();
        if (!worker) {
            worker = await context.waitForEvent('serviceworker');
        }
        const extensionId = new URL(worker.url()).host;
        const base = `chrome-extension://${extensionId}`;
        const pageErrors = [];
        for (const ctx of ['page', 'page2']) {
            const page = await context.newPage();
            page.on('pageerror', (err) => pageErrors.push(`${ctx}: ${err.message}`));
            await page.goto(`${base}/page.html?ctx=${ctx}`);
        }
        const driver = await context.newPage();
        await driver.goto(`${base}/driver.html`);

        console.log(`Browser: ${await driver.evaluate(() => navigator.userAgent)}`);
        console.log(`Host: ${os.platform()} ${os.release()}`);
        console.log(`Contexts answering: ${(await driver.evaluate(() => self.pingAll(['worker', 'page', 'page2']))).join(', ')}`);
        console.log(`navigator.locks.request in the worker: ${await worker.evaluate(() => typeof navigator.locks?.request)}`);
        console.log('');
        console.log('Lock visibility (holder takes ng-ga4:client-id, asker requests it with ifAvailable):');
        for (const [holder, asker] of [['worker', 'page'], ['page', 'worker'], ['page', 'page2']]) {
            const r = await driver.evaluate(([h, a]) => self.crossTry(h, a), [holder, asker]);
            console.log(`  ${holder} holds, ${asker} asks: granted=${r.acquired}, asker sees held=${JSON.stringify(r.held)}`);
        }

        console.log('');
        console.log(`Races (${RUNS} per arm; storage cleared, all callers told to start at once):`);
        let runId = 0;
        for (const arm of ARMS) {
            for (const useLocks of [false, true]) {
                let diverged = 0;
                let offStorage = 0;
                let errors = 0;
                for (let i = 0; i < RUNS; i++) {
                    const { results, stored } = await driver.evaluate(
                        ([run, locks, callers]) => self.race(run, locks, callers),
                        [runId++, useLocks, arm.callers]
                    );
                    if (results.some((r) => r.error)) {
                        errors++;
                        if (errors === 1) {
                            console.log(`    first error: ${JSON.stringify(results.filter((r) => r.error))}`);
                        }
                    }
                    const ids = new Set(results.map((r) => r.id));
                    if (ids.size > 1) {
                        diverged++;
                    }
                    if (results.some((r) => r.id !== stored)) {
                        offStorage++;
                    }
                }
                console.log(
                    `  ${arm.name}, lock ${useLocks ? 'on ' : 'off'}: ` +
                    `more than one ID in ${diverged}/${RUNS}; ` +
                    `a context kept an ID not in storage in ${offStorage}/${RUNS}; errors ${errors}`
                );
            }
        }
        if (pageErrors.length) {
            console.log('');
            console.log(`Uncaught page errors: ${pageErrors.length}, first: ${pageErrors[0]}`);
        }
    } finally {
        await context.close();
        fs.rmSync(profile, { recursive: true, force: true });
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
