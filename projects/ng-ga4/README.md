# @stream-vessel/ng-ga4

Angular library for Google Analytics 4 using the [Measurement Protocol](https://developers.google.com/analytics/devguides/collection/protocol/ga4). Works in both standard web apps and Chrome extensions (Manifest V3).

Built according to the official [Chrome Extensions GA4 guide](https://developer.chrome.com/docs/extensions/how-to/integrate/google-analytics-4).

## Features

- GA4 Measurement Protocol — no gtag.js or external scripts, CSP-compatible
- Automatic page view tracking via Angular Router
- Session management with 30-minute timeout
- Persistent client ID (survives app restarts)
- Chrome extension support (`chrome.storage.local` for identity, `chrome.storage.session` for sessions)
- Debug mode with validation endpoint
- Supports both NgModule and standalone Angular apps

## Installation

```bash
npm install @stream-vessel/ng-ga4
```

## Setup

### Prerequisites

1. A Google Analytics 4 property
2. A Measurement Protocol API secret (Admin > Data Streams > your stream > Measurement Protocol API secrets)

### NgModule apps

```typescript
import { NgGa4Module } from '@stream-vessel/ng-ga4';

@NgModule({
    imports: [
        NgGa4Module.forRoot({
            measurementId: 'G-XXXXXXXXX',
            apiSecret: 'your-api-secret',
            enabled: true,
            isExtension: false
        })
    ]
})
export class AppModule {}
```

### Standalone apps

```typescript
import { provideNgGa4 } from '@stream-vessel/ng-ga4';

bootstrapApplication(AppComponent, {
    providers: [
        provideNgGa4({
            measurementId: 'G-XXXXXXXXX',
            apiSecret: 'your-api-secret',
            enabled: true,
            isExtension: false
        })
    ]
});
```

## Configuration

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `measurementId` | `string` | Yes | GA4 Measurement ID (e.g. `G-XXXXXXXXX`) |
| `apiSecret` | `string` | Yes | Measurement Protocol API secret |
| `enabled` | `boolean` | Yes | Enable/disable analytics (no-ops when `false`) |
| `isExtension` | `boolean` | Yes | Set `true` for Chrome extensions — uses `chrome.storage` instead of `localStorage` |
| `siteUrl` | `string` | No | Base URL for `page_location` parameter. Required for extensions since `document.location.href` points to `chrome-extension://` |
| `debug` | `boolean` | No | Send events to the GA4 debug endpoint and log validation responses to the console |

## Usage

### Automatic page views

Page views are tracked automatically on every Angular Router `NavigationEnd` event. No additional code needed.

### Custom events

```typescript
import { NgGa4Service } from '@stream-vessel/ng-ga4';

@Component({ ... })
export class MyComponent {
    constructor(private analytics: NgGa4Service) {}

    onLogin() {
        this.analytics.trackEvent('login', { method: 'google' });
    }
}
```

### Manual page views

```typescript
this.analytics.trackPageView('/custom-page', 'Custom Page Title');
```

## API

### `NgGa4Service`

| Method | Description |
|--------|-------------|
| `init(): Promise<void>` | Initialize analytics. Called automatically via `APP_INITIALIZER`. |
| `trackPageView(pagePath: string, pageTitle?: string): void` | Track a page view. Called automatically on router navigation. |
| `trackEvent(name: string, params?: Record<string, any>): void` | Track a custom event. |

All methods are no-ops when `enabled` is `false` or before initialization.

## Chrome Extension Setup

1. Add `"storage"` to your `manifest.json` permissions:

```json
{
    "permissions": ["storage"]
}
```

2. Ensure your CSP allows the extension to make requests (the default `script-src 'self'` is fine — no external scripts are loaded):

```json
{
    "content_security_policy": {
        "extension_pages": "script-src 'self'; object-src 'self'"
    }
}
```

3. Set `isExtension: true` and provide a `siteUrl`:

```typescript
NgGa4Module.forRoot({
    measurementId: 'G-XXXXXXXXX',
    apiSecret: 'your-api-secret',
    enabled: true,
    isExtension: true,
    siteUrl: 'https://your-extension-domain.com'
})
```

### Storage strategy

| Data | Web | Extension |
|------|-----|-----------|
| Client ID | `localStorage` | `chrome.storage.local` |
| Session number | `localStorage` | `chrome.storage.local` |
| Session ID + activity | `localStorage` | `chrome.storage.session` |

## Debug Mode

Set `debug: true` to send events to the [GA4 debug endpoint](https://developers.google.com/analytics/devguides/collection/protocol/ga4/validating-events). Validation responses are logged to the browser console.

```typescript
NgGa4Module.forRoot({
    ...config,
    debug: !environment.production
})
```

## Security notes

The API secret is visible to anyone who inspects the built bundle. This is inherent to Measurement Protocol from the browser — the client needs the secret to authenticate. Google follows the same pattern in its Chrome Extensions GA4 guide.

Impact is bounded:
- An extracted secret only lets an attacker send fake events to your property (polluting data and consuming quota).
- It grants no read access to your analytics.

Mitigation: watch your GA4 property for unusual event volume. If abuse shows up, rotate the secret (Admin → Data Streams → your stream → Measurement Protocol API secrets → delete + create), then redeploy the client with the new value.

## Peer Dependencies

- `@angular/core` ^16.0.0 || ^17.0.0 || ^18.0.0 || ^19.0.0
- `@angular/common` ^16.0.0 || ^17.0.0 || ^18.0.0 || ^19.0.0
- `@angular/router` ^16.0.0 || ^17.0.0 || ^18.0.0 || ^19.0.0

## License

Commercial
