# Token Monitor for Android

A read-only viewer for a [LAN gateway](../docs/lan-gateway.md). It finds gateways
on the current Wi-Fi network over mDNS, or connects to one by address, and then
watches its view plane over plain HTTP and SSE.

It is a viewer only. It collects nothing, holds no hub secret, and can neither
ingest usage nor change any setting on the gateway.

## Requirements

- Android Studio **Ladybug (2024.2)** or newer (AGP 8.7 / Gradle 8.9 / Kotlin 2.0.21)
- JDK 17
- `compileSdk 35`, `minSdk 26` (Android 8.0), `targetSdk 35`
- An Android device or emulator on the **same network** as the gateway

## Build

```bash
cd android

# Generate the Gradle wrapper (it is not committed — the wrapper jar is a binary).
# Android Studio will offer to do this on import instead.
gradle wrapper --gradle-version 8.9

./gradlew :app:assembleDebug      # or :app:installDebug with a device attached
```

Opening the folder in Android Studio works too: it generates the wrapper and
syncs Gradle on import.

## Run the gateway it talks to

The easiest way is the desktop widget: **Settings → Multi-device Sync → Host hub
on this device**, then turn **Read-only view** on. The widget advertises the
gateway over mDNS and lists its LAN addresses. The Android app needs the view
plane enabled — it is off by default, so an app that finds a gateway with no
view port has nothing to open.

Or run the standalone process from the repository root:

```bash
npm run gateway -- --secret "$(openssl rand -hex 32)"
```

It prints both ports. The app connects to the **view plane** (`17322` by
default); the data plane (`17321`) is where devices post usage and is
secret-protected. Add `--view 0` to run a data-plane-only gateway with no
unauthenticated view (the app cannot then read it).

## Permissions

Only `INTERNET` and `ACCESS_NETWORK_STATE`. No location permission is requested —
Android does not require one for `NsdManager` service discovery.

## Cleartext HTTP

The view plane is deliberately unencrypted and unauthenticated, so the app
declares `android:usesCleartextTraffic="true"` **and** a
`network_security_config.xml`. Android has blocked cleartext by default since
API 28; the flag alone is enough on stock Android, but some OEM builds ignore
it for private (RFC1918) addresses and enforce a per-domain config instead — a
state that surfaces as `CLEARTEXT ... not permitted by network security policy`
even with the flag present, and which the config file in `res/xml/` fixes.

This is safe **only** on a network you trust. On a hostile one, an
unauthenticated HTTP read of that port is visible to anyone on it, and the app
has no way to verify who answered.

## Layout

```
app/src/main/java/com/javis/tokenmonitor/
  MainActivity.kt              picks the list or the dashboard
  GatewayViewModel.kt          selection, SSE subscription, reconnect
  data/Models.kt               /api/view/stats wire shapes
  data/GatewayApi.kt           OkHttp: one-shot reads + hand-rolled SSE
  data/GatewayStore.kt         DataStore: remembered gateways
  discovery/NsdDiscovery.kt    NsdManager mDNS discovery
  ui/DashboardScreen.kt        overview, breakdowns, limits, devices
  ui/GatewaysScreen.kt         discovery, saved, manual entry
  ui/Format.kt                 token / money / relative-time formatting
```

## Manual acceptance checklist

There are no automated tests here — the development machine that produced this
project has no Android SDK, so anything written could not have been run. Verify
by hand:

**Discovery**

1. Start the gateway with `--mdns 0`. The app shows the "looking…" placeholder
   and stays there.
2. Restart it without that flag. Within a few seconds the gateway appears under
   "Found on this network" with its hostname as the title.
3. Quit the gateway. The entry disappears.
4. Turn the phone's Wi-Fi off and on. Discovery resumes without restarting the app.

**Connection**

5. Tap a discovered gateway. The dashboard opens and shows data within a second.
6. Confirm the title bar shows the hostname and a "Live" status dot.
7. Add a second gateway by address (host + `17322`). It appears under "Saved".
8. Use the swap button in the top-left to switch between them; the previous
   stream must stop, not run alongside the new one.
9. Long-press Forget on a saved gateway; it is removed from the list.
10. Kill the gateway. The status goes to an error and the **last good reading
    stays on screen**. Restart it; the app reconnects on its own within ~5s.

**Streaming**

11. With the dashboard open, let a device post new usage. Numbers update without
    pulling to refresh.
12. Leave the numbers alone for over a minute. They must not drift to an error —
    the gateway's 30s heartbeat is what keeps the stream alive.
13. Background the app and return. It reconnects and shows current data.

**Rendering**

14. Switch Today / Month / All time. Tokens, cost and every breakdown follow.
15. Rotate the phone. The selected period survives.
16. A gateway reporting a `credits` window (DeepSeek, OpenRouter, third-party)
    shows an **amount**, not a percentage, and draws no meter bar for it.
17. A device that has not reported recently is labelled "Offline" while the
    others stay "Live".
18. Confirm no account email, account name, plan label or workspace path appears
    anywhere in the UI — the view plane strips them, and the app must not be
    showing something the server failed to remove.
