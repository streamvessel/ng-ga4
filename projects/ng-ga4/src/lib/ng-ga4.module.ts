import { APP_INITIALIZER, ModuleWithProviders, NgModule } from '@angular/core';
import { NG_GA4_CONFIG, NgGa4Config } from './ng-ga4.config';
import { NgGa4Service } from './ng-ga4.service';

export function initializeNgGa4(service: NgGa4Service): () => Promise<void> {
    return () => service.init();
}

@NgModule()
export class NgGa4Module {
    static forRoot(config: NgGa4Config): ModuleWithProviders<NgGa4Module> {
        return {
            ngModule: NgGa4Module,
            providers: [
                { provide: NG_GA4_CONFIG, useValue: config },
                NgGa4Service,
                {
                    provide: APP_INITIALIZER,
                    useFactory: initializeNgGa4,
                    deps: [NgGa4Service],
                    multi: true
                }
            ]
        };
    }
}
