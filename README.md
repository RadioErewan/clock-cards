# Clock Cards

Two clocks for Home Assistant dashboards: a broadcast **studio clock** and a **flip clock** with
the weather. The studio clock is ready; the flip clock is still to come.

Made for the idle page of [Wall Panel for HA](https://github.com/RadioErewan), and good on any
dashboard: browser, the HA app, Fully Kiosk.

## Studio Clock (`custom:studio-clock-card`)

A ring of sixty dots lit up to the current second, the time in red, and a countdown to the next
event in your calendar. While an event is on air the countdown turns amber and runs to its end;
the arc inside the ring shows how far along it is. In the last seconds before a start the face
becomes a film leader: one large digit and a sweep round the ring each second.

- Reads any `calendar.*` entities (Google Calendar, CalDAV, Local Calendar, Microsoft 365 …).
  It sees what your HA user sees. All-day events are ignored: a studio clock counts timed ones.
- Overlapping events: the one that started last is shown, the others as "Also on air".
- Meeting invitations (Zoom, Teams, Meet) are cut out of the event notes.
- An optional `timer.*` entity takes over while it runs, and counts up for a minute when it ends.
- Picture shifts a few pixels every three minutes against AMOLED burn-in.

### Options

| Option | Default | |
|---|---|---|
| `entities` | | List of `calendar.*` entities |
| `timer` | | A `timer.*` entity, optional |
| `leader` | `5` | Seconds of film leader before a start, `0` for none |
| `layout` | `auto` | `auto`, `compact` (text inside the ring) or `wide` (text beside it, with a rundown) |
| `height` | | Any CSS length, such as `90vh`, for dashboards that do not stretch the card |
| `burn_in_shift` | `true` | Shift the picture now and then |

```yaml
type: custom:studio-clock-card
entities:
  - calendar.work
timer: timer.studio
layout: auto
```

## Install

Copy `dist/clock-cards.js` to `config/www/`, then add a dashboard resource
`/local/clock-cards.js?v=1` of type *JavaScript module*. Change the number in `?v=` after each
update, so browsers load the new file.

## Related

[Studio Clock](https://3210.lu) for Android, iOS and the web — the same clock as an app.
