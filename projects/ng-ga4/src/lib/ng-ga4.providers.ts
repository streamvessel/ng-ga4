import { APP_INITIALIZER, EnvironmentProviders, makeEnvironmentProviders } from '@angular/core';
import { NG_GA4_CONFIG, NgGa4Config } from './ng-ga4.config';
import { NgGa4Service } from './ng-ga4.service';
import { initializeNgGa4 } from './ng-ga4.module';

export function provideNgGa4(config: NgGa4Config): EnvironmentProviders {
    return makeEnvironmentProviders([
        { provide: NG_GA4_CONFIG, useValue: config },
        NgGa4Service,
        {
            provide: APP_INITIALIZER,
            useFactory: initializeNgGa4,
            deps: [NgGa4Service],
            multi: true
        }
    ]);
}
