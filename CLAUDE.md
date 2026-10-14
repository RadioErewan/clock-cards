# Clock Cards — CLAUDE.md

Two Home Assistant dashboard cards in one file, `dist/clock-cards.js`: `studio-clock-card` and
`flip-clock-card`. Public on GitHub (once there is something to show), installed through HACS as a
custom repository. Conversation with Radek in Polish; card UI and README in English.

## Why

- Content for the **Idle page** of Wall Panel for HA (`~/Documents/hapanel`, see its CLAUDE.md ›
  Pending): the panel switches to an HA view while idle, and this view shows a clock. The cards
  work in any dashboard too — browser, HA app, Fully Kiosk.
- Brings Radek's existing clocks to HA. Link back to Studio Clock / Wall Panel for HA in the README.

## Template: `~/Documents/frad-card` (RadioErewan/frad-card, public)

- Plain JavaScript custom elements, no build step, no Lit: card class + `-editor` class,
  `customElements.define`, `window.customCards.push(...)` so the cards show in the card picker.
- `hacs.json` (`filename`), MIT `LICENSE`, `.github/workflows/validate.yml` (HACS action, manual
  or on PRs only), `CHANGELOG.md`, `docs/screenshot.png`, GitHub releases with the JS attached.
- One repo can define both cards: HACS installs one file, the file registers two elements.

## Sources to port (`~/Documents/IUD Clock`)

- Studio clock: Android `Android/app/src/main/java/ie/a3210/studioclock/` (`StudioFace.kt`,
  `Studio.kt`, `CalendarSource.kt`); Swift `FlipClock/Shared/StudioClock.swift`,
  `StudioClockView.swift`, `StudioCalendar.swift`.
- Flip clock: `FlipClock/Shared/FlipClockWidgetView.swift`, `ClockTheme.swift`, weather in
  `WeatherService.swift` / `WeatherModel.swift` / `SymbolMapper.swift`, pollen in `PollenModel.swift`.
- Design brief for the flip clock: `IUD Clock/htc-flipclock-widget-brief.md`.

## Data from Home Assistant instead of the device

- **Weather**: a `weather.*` entity. Current state and attributes from `hass.states`; the forecast
  through `hass.connection.subscribeMessage(cb, {type: "weather/subscribe_forecast",
  entity_id, forecast_type: "daily"})` (forecast attributes were removed from weather entities).
  No Open-Meteo, no API key, no location.
- **Calendar**: any `calendar.*` entities (Google Calendar, CalDAV, Local Calendar, Microsoft 365
  through their HA integrations). Events through
  `hass.callApi("GET", "calendars/<entity_id>?start=<ISO>&end=<ISO>")`; the entity's own state and
  `message`/`start_time` attributes give the current or next event without a call. The card only
  sees what the HA user may see; nothing to grant in the card.
- **Pollen / other values**: any sensor entity the user picks.
- Time: the device clock (HA panels are usually NTP-synced); optional offset is not needed.

## Rules

- AMOLED burn-in: static digits must move a few pixels every few minutes (option, on by default
  for the flip clock).
- Honour `prefers-reduced-motion` like frad-card does.
- Keep each card's options small; visual editor for all of them.

## Status

- 13 Oct 2026: folder created with the skeleton (hacs.json, LICENSE, workflow). No code, no GitHub
  repo yet. Order: Idle page in the app → studio clock card → flip clock card.
- 14 Oct 2026: studio clock card done (`studio-clock-card` in `dist/clock-cards.js`, 0.2.0):
  calendar events, film leader, optional `timer.*`, burn-in shift, visual editor; tried in Radek's
  HA. Install by hand for now: `config/www/` + resource `?v=N`. Not done: beeps, GitHub repo and
  release, screenshot. Next: flip clock card.
