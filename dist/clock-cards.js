/**
 * Clock Cards - studio-clock-card and flip-clock-card for Home Assistant.
 *
 * studio-clock-card: a broadcast studio clock. A ring of sixty dots, the time in red,
 * a countdown to the next calendar event (amber while it is on air), and the event's
 * details beside or under it. The last seconds before a start run as a film leader.
 *
 * MIT licensed.
 */

const CARD_VERSION = "0.2.0";

/* ------------------------------------------------------------------ */
/* Studio clock: rules, ported from Studio.kt / StudioClock.swift      */
/* ------------------------------------------------------------------ */

const DAY = 24 * 60 * 60 * 1000;
const FLASH = 700;

/** What the clock shows at `now`, given events {id,title,notes,location,start,end} in ms. */
function studioState(now, slots) {
  const upcoming = slots
    .filter((s) => s.start > now)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const running = slots
    .filter((s) => s.start <= now && now < s.end)
    .sort((a, b) => b.start - a.start || a.end - b.end);

  if (running.length) {
    const cur = running[0];
    return {
      phase: { kind: "onair", from: cur.start, to: cur.end },
      slot: cur,
      alsoOnAir: running.slice(1),
      next: upcoming[0] || null,
      upcoming: upcoming.slice(0, 4),
    };
  }
  if (!upcoming.length) return { phase: { kind: "idle" }, slot: null, alsoOnAir: [], next: null, upcoming: [] };
  return {
    phase: { kind: "countdown", from: null, to: upcoming[0].start },
    slot: upcoming[0],
    alsoOnAir: [],
    next: upcoming[1] || null,
    upcoming: upcoming.slice(1, 5),
  };
}

/** How far through the segment the clock is, 0..1, or null when there is no arc. */
function studioProgress(state, now) {
  const p = state.phase;
  const frac = (from, to) => (to - from > 0 ? Math.min(1, Math.max(0, (now - from) / (to - from))) : null);
  if (p.kind === "countdown") {
    // Waiting for an event has no beginning: read the ring as minutes on a sixty-minute dial.
    return p.from == null ? Math.min(1, Math.max(0, (p.to - now) / 3_600_000)) : frac(p.from, p.to);
  }
  if (p.kind === "onair") return frac(p.from, p.to);
  if (p.kind === "overrun") return 1;
  return null;
}

/** Milliseconds to the next start the leader counts in to, or null. */
function startRemaining(state, now) {
  let target;
  if (state.phase.kind === "countdown") target = state.phase.to;
  else if (state.phase.kind === "onair" && state.next) target = state.next.start;
  else return null;
  return target - now > 0 ? target - now : null;
}

/** 0..1 through the flash that marks going on air, or null. */
function studioFlash(phase, now) {
  let since;
  if (phase.kind === "onair") since = now - phase.from;
  else if (phase.kind === "overrun") since = now - phase.since;
  else return null;
  return since >= 0 && since < FLASH ? since / FLASH : null;
}

const INVITATION_MARKERS = [
  "join zoom meeting", "microsoft teams", "join with google meet", "join the meeting",
  "meeting id:", "join on your computer", "click here to join", "-::~:~::",
];

/** Event notes are mostly a meeting invitation: keep the text above the first sign of one. */
function cleanNotes(raw) {
  if (!raw || !String(raw).trim()) return null;
  let text = String(raw)
    .replace(/<\s*(br|\/p|\/div|\/li)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
  const kept = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    const lower = t.toLowerCase();
    if (INVITATION_MARKERS.some((m) => lower.includes(m))) break;
    if (t.length >= 5 && /^[-_=\u2500\u2501\u2010\u2013\u2014*]+$/.test(t)) break;
    if (!t && (!kept.length || !kept[kept.length - 1])) continue;
    kept.push(t);
  }
  return kept.join("\n").trim() || null;
}

/** "0:05:00" / "00:03:12.5" as milliseconds, or null. */
function parseDuration(text) {
  const m = /^(?:(\d+):)?(\d+):(\d+)(?:\.\d+)?$/.exec(String(text || "").trim());
  return m ? (Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 : null;
}

const OVERRUN_MS = 60 * 1000;

const pad2 = (n) => String(n).padStart(2, "0");
const hms = (ms) => {
  const total = Math.floor((Math.max(0, ms) + 999) / 1000);
  return `${pad2(Math.floor(total / 3600))}:${pad2(Math.floor(total / 60) % 60)}:${pad2(total % 60)}`;
};

/* ------------------------------------------------------------------ */
/* Studio clock card                                                   */
/* ------------------------------------------------------------------ */

const STUDIO_DEFAULTS = { entities: [], timer: "", leader: 5, layout: "auto", height: "", burn_in_shift: true };
const SVG = "http://www.w3.org/2000/svg";
const REFRESH_MS = 5 * 60 * 1000;

const STUDIO_CSS = `
:host { display: block; height: 100%; }
ha-card { background: #000; color: #fff; overflow: hidden; height: 100%; }
.wrap { container-type: size; width: 100%; height: 100%; min-height: 240px; display: flex;
  align-items: center; justify-content: center; font-family: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace; }
.wrap.wide { gap: 4.5cqw; padding: 0 5cqw; justify-content: flex-start; }
.face { position: relative; aspect-ratio: 1; flex: none; container-type: size; }
.wrap.compact .face { width: 95cqmin; }
.wrap.wide .face { width: min(90cqh, 48cqw); }
.face svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.dot { fill: #F03329; opacity: .22; }
.dot.lit { opacity: 1; }
.dot.steady { opacity: .5; }
.arc { fill: none; stroke-width: 1.3; transform: rotate(-90deg); transform-origin: 50% 50%; }
.flash { fill: #000; opacity: 0; }
.lead line { stroke: #F03329; opacity: .35; stroke-width: .3; }
.lead circle { fill: none; transform: rotate(-90deg); transform-origin: 50% 50%; }
.inner { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 2cqw; }
.wrap.compact .inner.has-details { padding-top: 6cqw; }
.time { color: #F03329; font-size: 12cqw; line-height: 1; white-space: nowrap; }
.badge { height: 7.5cqw; border-radius: 1.65cqw; padding: 0 3.4cqw; display: flex; align-items: center;
  font: 900 4.5cqw/1 system-ui, sans-serif; border: 1px solid; box-sizing: border-box; }
.badge.filled { color: #000; }
.badge.none { visibility: hidden; }
.count { font-size: 15cqw; line-height: 1; white-space: nowrap; }
.count.start { font-size: 11cqw; }
.digit { position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
  font-size: 42cqw; line-height: 1; }
.digit.two { font-size: 32cqw; }
.face.leader .inner { visibility: hidden; }
.face.leader .digit { display: flex; }
.details { display: flex; flex-direction: column; gap: 1cqh; min-width: 0; font-family: system-ui, sans-serif; }
.wrap.compact .details { width: 52cqw; gap: .3cqw; align-items: center; text-align: center; }
.wrap.wide .details { flex: 1; text-align: left; gap: 1.8cqh; }
.details div { overflow: hidden; text-overflow: ellipsis; line-height: 1.2; }
.title { color: rgba(255,255,255,.92); font-weight: 600; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.small { color: rgba(255,255,255,.55); }
.notes { color: rgba(255,255,255,.69); display: -webkit-box; -webkit-box-orient: vertical; white-space: pre-line; }
.also { color: rgba(255,179,26,.85); }
.head { color: rgba(255,255,255,.55); font-weight: 600; margin-top: 1.5cqh; }
.row { color: rgba(255,255,255,.92); }
.wrap.compact .title { font-size: 4.95cqw; }
.wrap.compact .small, .wrap.compact .notes, .wrap.compact .also, .wrap.compact .row { font-size: 3.24cqw; }
.wrap.compact .notes { -webkit-line-clamp: 2; }
.wrap.wide .title { font-size: 5.5cqh; }
.wrap.wide .small, .wrap.wide .notes, .wrap.wide .also, .wrap.wide .row { font-size: 3.6cqh; }
.wrap.wide .notes { -webkit-line-clamp: 6; }
.wrap.wide .head { font-size: 2.6cqh; }
.wrap.compact .head { display: none; }
`;

class StudioClockCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = null;
    this._hass = null;
    this._slots = [];
    this._notice = null;
    this._timer = null;
    this._lastFetch = 0;
    this._fetching = false;
    this._built = false;
    this._wide = false;
    this._reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  static getStubConfig(hass, entities) {
    const cal = (entities || []).find((e) => e.startsWith("calendar."));
    return { type: "custom:studio-clock-card", entities: cal ? [cal] : [] };
  }

  static getConfigElement() {
    return document.createElement("studio-clock-card-editor");
  }

  getCardSize() { return 4; }

  setConfig(config) {
    if (!config) throw new Error("Invalid configuration");
    const entities = [].concat(config.entities || config.entity || []);
    this._config = { ...STUDIO_DEFAULTS, ...config, entities };
    this._lastFetch = 0;
    if (this._built) this._applyLayout();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) this._build();
    this._maybeFetch();
  }

  connectedCallback() {
    if (this._built) this._start();
  }

  disconnectedCallback() {
    clearTimeout(this._timer);
    this._timer = null;
    if (this._ro) this._ro.disconnect();
  }

  /* ---- data ---- */

  async _maybeFetch() {
    if (this._fetching || !this._hass || !this._config) return;
    if (Date.now() - this._lastFetch < REFRESH_MS) return;
    const ids = this._config.entities;
    if (!ids.length) { this._notice = "Choose one or more calendar entities in the card settings."; return; }
    this._fetching = true;
    this._lastFetch = Date.now();
    const now = Date.now();
    const start = new Date(now - DAY).toISOString();
    const end = new Date(now + 14 * DAY).toISOString();
    try {
      const results = await Promise.all(ids.map((id) =>
        this._hass.callApi("GET", `calendars/${id}?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`)
          .catch(() => null)));
      const slots = [];
      let failed = 0;
      results.forEach((events, i) => {
        if (!events) { failed++; return; }
        events.forEach((ev, n) => {
          const s = typeof ev.start === "string" ? ev.start : ev.start && (ev.start.dateTime || ev.start.date);
          const e = typeof ev.end === "string" ? ev.end : ev.end && (ev.end.dateTime || ev.end.date);
          // A studio clock counts timed events; all-day entries have a date and no time.
          if (!s || !e || !s.includes("T") || !e.includes("T")) return;
          const a = Date.parse(s), b = Date.parse(e);
          if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return;
          slots.push({
            id: `${ids[i]}:${n}`, title: ev.summary || "(No title)",
            notes: cleanNotes(ev.description), location: ev.location || null, start: a, end: b,
          });
        });
      });
      this._slots = slots;
      this._notice = failed === ids.length ? "Could not read the calendar." : null;
    } catch (err) {
      this._notice = "Could not read the calendar.";
    } finally {
      this._fetching = false;
    }
  }

  /**
   * A timer.* entity, when one is chosen and running, takes over from the calendar, as the manual
   * timer does on the Android clock. When it runs out the clock counts up for a minute.
   */
  _timerState(now) {
    const id = this._config.timer;
    const ent = id && this._hass && this._hass.states[id];
    const idle = { phase: { kind: "idle" }, slot: null, alsoOnAir: [], next: null, upcoming: [] };
    if (!ent) return null;
    const total = parseDuration(ent.attributes.duration);
    if (ent.state === "active" && ent.attributes.finishes_at) {
      const to = Date.parse(ent.attributes.finishes_at);
      if (Number.isFinite(to)) {
        this._timerEnd = to;
        return { ...idle, timer: "running", phase: { kind: "countdown", from: total ? to - total : null, to } };
      }
    }
    if (ent.state === "paused") {
      const left = parseDuration(ent.attributes.remaining);
      if (left != null) {
        return { ...idle, timer: "paused",
          phase: { kind: "countdown", from: total ? now + left - total : null, to: now + left } };
      }
    }
    // Finished (or cancelled): count up for a minute after a natural end.
    if (this._timerEnd && now >= this._timerEnd && now - this._timerEnd < OVERRUN_MS && ent.state === "idle") {
      return { ...idle, timer: "over", phase: { kind: "overrun", since: this._timerEnd } };
    }
    // Cancelled before its end: nothing to count up from.
    if (ent.state === "idle" && this._timerEnd && now < this._timerEnd - 2000) this._timerEnd = null;
    if (ent.state === "idle" && now - (this._timerEnd || 0) >= OVERRUN_MS) this._timerEnd = null;
    return null;
  }

  /* ---- DOM ---- */

  _build() {
    const root = this.shadowRoot;
    root.innerHTML = `<style>${STUDIO_CSS}</style>
      <ha-card><div class="wrap compact">
        <div class="face">
          <svg viewBox="0 0 100 100" aria-hidden="true">
            <g class="dots"></g>
            <circle class="arc" cx="50" cy="50" r="43.4"></circle>
            <circle class="flash" cx="50" cy="50" r="50"></circle>
            <g class="lead" style="display:none">
              <line x1="50" y1="0" x2="50" y2="100"></line><line x1="0" y1="50" x2="100" y2="50"></line>
              <circle class="lead-track" cx="50" cy="50" r="40" stroke-width=".4"></circle>
              <circle class="lead-sweep" cx="50" cy="50" r="40" stroke-width="3.5"></circle>
            </g>
          </svg>
          <div class="inner">
            <div class="time"></div>
            <div class="badge"></div>
            <div class="count"></div>
          </div>
          <div class="digit"></div>
        </div>
        <div class="details"></div>
      </div></ha-card>`;
    this._wrap = root.querySelector(".wrap");
    this._face = root.querySelector(".face");
    this._inner = root.querySelector(".inner");
    this._details = root.querySelector(".details");
    this._arc = root.querySelector(".arc");
    this._flash = root.querySelector(".flash");
    this._lead = root.querySelector(".lead");
    this._leadSweep = root.querySelector(".lead-sweep");
    this._leadTrack = root.querySelector(".lead-track");
    this._time = root.querySelector(".time");
    this._badge = root.querySelector(".badge");
    this._count = root.querySelector(".count");
    this._digit = root.querySelector(".digit");

    const dots = root.querySelector(".dots");
    this._dots = [];
    const dot = 2.4, radius = 50 - dot;
    for (let i = 0; i < 60; i++) {
      const scale = i % 15 === 0 ? 1.4 : i % 5 === 0 ? 1.15 : 1;
      const a = ((i * 6 - 90) * Math.PI) / 180;
      const c = document.createElementNS(SVG, "circle");
      c.setAttribute("class", "dot");
      c.setAttribute("cx", (50 + radius * Math.cos(a)).toFixed(3));
      c.setAttribute("cy", (50 + radius * Math.sin(a)).toFixed(3));
      c.setAttribute("r", ((dot * scale) / 2).toFixed(3));
      dots.appendChild(c);
      this._dots.push(c);
    }
    this._circ = 2 * Math.PI * 43.4;
    this._leadCirc = 2 * Math.PI * 40;
    this._detailKey = null;

    this._ro = new ResizeObserver(() => this._applyLayout());
    this._ro.observe(this);
    this._built = true;
    this._applyLayout();
    this._start();
  }

  _applyLayout() {
    if (!this._built) return;
    const mode = this._config.layout;
    const w = this.clientWidth, h = this.clientHeight || this._wrap.clientHeight;
    const wide = mode === "wide" || (mode === "auto" && w > 0 && h > 0 && w / h > 1.4);
    this._wide = wide;
    // Optional fixed height (any CSS length, e.g. "90vh") for dashboards that do not stretch the card.
    this._wrap.style.height = this._config.height ? String(this._config.height) : "";
    this._wrap.classList.toggle("wide", wide);
    this._wrap.classList.toggle("compact", !wide);
    // Compact: the details sit inside the ring under the countdown. Wide: beside it.
    if (wide) {
      if (this._details.parentNode !== this._wrap) this._wrap.appendChild(this._details);
    } else if (this._details.parentNode !== this._inner) {
      this._inner.appendChild(this._details);
    }
    this._detailKey = null;
  }

  _start() {
    clearTimeout(this._timer);
    const tick = () => {
      this._tick();
      this._timer = setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
    };
    tick();
  }

  _tick() {
    if (!this._built || !this._config) return;
    this._maybeFetch();
    const now = Date.now();
    const state = this._timerState(now) || studioState(now, this._slots);
    const phase = state.phase;
    const accent = phase.kind === "onair" ? "#FFB51A" : phase.kind === "overrun" ? "#F03329" : "#6BF54A";
    const second = new Date(now).getSeconds();
    const lead = startRemaining(state, now);
    const leaderMs = Math.max(0, Number(this._config.leader) || 0) * 1000;
    const leader = leaderMs > 0 && lead != null && lead <= leaderMs && state.timer !== "paused" ? lead : null;

    // Ring dots
    for (let i = 0; i < 60; i++) {
      const c = this._dots[i];
      const on = leader != null ? "steady" : i <= second ? "lit" : "";
      if (c._state !== on) { c.setAttribute("class", "dot" + (on ? " " + on : "")); c._state = on; }
    }

    this._face.classList.toggle("leader", leader != null);
    this._lead.style.display = leader != null ? "" : "none";
    if (leader != null) {
      const digit = Math.floor((leader + 999) / 1000);
      const sweep = 1 - (leader % 1000) / 1000;
      this._digit.textContent = String(digit);
      this._digit.classList.toggle("two", digit >= 10);
      this._digit.style.color = "#6BF54A";
      this._leadTrack.style.stroke = "rgba(107,245,74,.3)";
      this._leadSweep.style.stroke = "#6BF54A";
      this._leadSweep.style.strokeDasharray = `${this._leadCirc * sweep} ${this._leadCirc}`;
      this._arc.style.display = "none";
    } else {
      const progress = studioProgress(state, now);
      this._arc.style.display = progress ? "" : "none";
      if (progress) {
        this._arc.style.stroke = accent;
        this._arc.style.strokeDasharray = `${this._circ * progress} ${this._circ}`;
      }
    }

    const flash = this._reduced ? null : studioFlash(phase, now);
    this._flash.style.opacity = flash != null && leader == null ? String(0.45 * (1 - flash)) : "0";
    this._flash.style.fill = accent;

    // Time, badge, countdown
    const d = new Date(now);
    this._time.textContent = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    const label = phase.kind === "onair" ? "ON AIR" : phase.kind === "overrun" ? "OVER"
      : phase.kind === "countdown" ? (state.timer === "paused" ? "PAUSED" : state.timer ? "TIMER" : "NEXT") : null;
    this._badge.textContent = label || "";
    this._badge.className = "badge" + (label == null ? " none" : phase.kind === "countdown" ? "" : " filled");
    this._badge.style.color = phase.kind === "countdown" ? accent : "#000";
    this._badge.style.borderColor = accent;
    this._badge.style.background = phase.kind === "countdown" || label == null ? "transparent" : accent;
    this._count.style.color = phase.kind === "idle" ? "rgba(255,255,255,.55)" : accent;
    const text = this._countdown(phase, now);
    this._count.textContent = text;
    this._count.classList.toggle("start", text.length > 8);

    this._renderDetails(state, now);
    this._shift(now);
  }

  /** A few pixels' drift every three minutes, so static digits do not burn into an AMOLED panel. */
  _shift(now) {
    const steps = [[0, 0], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1]];
    const step = this._config.burn_in_shift === false ? 0 : Math.floor(now / 180000) % steps.length;
    if (step === this._step) return;
    this._step = step;
    const px = Math.max(1, Math.round(Math.min(this.clientWidth, this.clientHeight || 240) * 0.008));
    const [x, y] = steps[step];
    this._wrap.style.transform = x || y ? `translate(${x * px}px, ${y * px}px)` : "";
  }

  _countdown(phase, now) {
    if (phase.kind === "countdown") {
      return phase.to - now > DAY ? this._startLabel(phase.to, now) : hms(phase.to - now);
    }
    if (phase.kind === "onair") return hms(phase.to - now);
    if (phase.kind === "overrun") return "+" + hms(now - phase.since);
    return "--:--:--";
  }

  _lang() { return (this._hass && this._hass.locale && this._hass.locale.language) || undefined; }

  _clock(ms) {
    const d = new Date(ms);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  /** Start time, with the weekday when it is not today. */
  _startLabel(ms, now) {
    const same = new Date(ms).toDateString() === new Date(now).toDateString();
    return same ? this._clock(ms)
      : `${new Date(ms).toLocaleDateString(this._lang(), { weekday: "short" })} ${this._clock(ms)}`;
  }

  _renderDetails(state, now) {
    const slot = state.slot;
    const rows = [];
    const add = (cls, text) => rows.push([cls, text]);
    if (state.timer) {
      const p = state.phase;
      add("title", state.timer === "over" ? "Time is up" : state.timer === "paused" ? "Timer paused" : "Timer running");
      if (state.timer === "over") add("small", `Ended at ${this._clock(p.since)}`);
      else if (state.timer === "running") add("small", `Ends at ${this._clock(p.to)}`);
    } else if (this._notice && !slot) {
      add("small", this._notice);
    } else if (slot) {
      add("title", slot.title);
      let range = `${this._clock(slot.start)}\u2013${this._clock(slot.end)}`;
      if (new Date(slot.start).toDateString() !== new Date(now).toDateString()) {
        range = `${new Date(slot.start).toLocaleDateString(this._lang(), { weekday: "short", day: "numeric" })} ${range}`;
      }
      add("small", [range, slot.location].filter(Boolean).join(" \u00b7 "));
      if (slot.notes) add("notes", slot.notes);
      if (state.alsoOnAir.length) {
        const more = state.alsoOnAir.length > 1 ? ` +${state.alsoOnAir.length - 1}` : "";
        add("also", `Also on air: ${state.alsoOnAir[0].title}${more}`);
      }
      if (this._wide && state.upcoming.length) {
        add("head", "UPCOMING");
        state.upcoming.slice(0, 3).forEach((s) => add("row", `${this._startLabel(s.start, now)}  ${s.title}`));
      } else if (state.next) {
        add("small", `Then ${this._startLabel(state.next.start, now)}  ${state.next.title}`);
      }
    } else {
      add("title", "Nothing coming up");
      add("small", "No timed events in the next two weeks.");
    }
    const key = JSON.stringify(rows) + this._wide;
    if (key === this._detailKey) return;
    this._detailKey = key;
    this._details.classList.toggle("has-details", rows.length > 0);
    this._inner.classList.toggle("has-details", !this._wide);
    this._details.replaceChildren(...rows.map(([cls, text]) => {
      const el = document.createElement("div");
      el.className = cls;
      el.textContent = text;
      return el;
    }));
  }
}

/* ------------------------------------------------------------------ */
/* Visual editor                                                       */
/* ------------------------------------------------------------------ */

class StudioClockCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { ...STUDIO_DEFAULTS, ...config };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
  }

  _render() {
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) => s.label || s.name;
      this._form.addEventListener("value-changed", (ev) => {
        this._config = { ...this._config, ...ev.detail.value };
        this.dispatchEvent(new CustomEvent("config-changed", {
          detail: { config: this._config }, bubbles: true, composed: true,
        }));
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.schema = [
      { name: "entities", label: "Calendars", selector: { entity: { domain: "calendar", multiple: true } } },
      { name: "timer", label: "Timer (optional; takes over while running)",
        selector: { entity: { domain: "timer" } } },
      { name: "leader", label: "Film leader before a start (seconds, 0 = off)",
        selector: { number: { min: 0, max: 60, mode: "box" } } },
      { name: "burn_in_shift", label: "Shift the picture a few pixels now and then (AMOLED burn-in)",
        selector: { boolean: {} } },
      { name: "height", label: "Height (CSS length, e.g. 90vh; empty = fill)", selector: { text: {} } },
      { name: "layout", label: "Layout", selector: { select: { mode: "dropdown", options: [
        { value: "auto", label: "Automatic" }, { value: "compact", label: "Ring with text inside" },
        { value: "wide", label: "Ring with text beside" },
      ] } } },
    ];
    this._form.data = this._config;
  }
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

if (!customElements.get("studio-clock-card")) {
  customElements.define("studio-clock-card", StudioClockCard);
  customElements.define("studio-clock-card-editor", StudioClockCardEditor);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: "studio-clock-card",
  name: "Studio Clock",
  description: "A broadcast studio clock: a ring of dots, the time, and a countdown to your next calendar event.",
  preview: false,
});

console.info(`%c CLOCK-CARDS %c ${CARD_VERSION} `, "background:#F03329;color:#fff", "background:#222;color:#fff");
