/**
 * Clock Cards - studio-clock-card and flip-clock-card for Home Assistant.
 *
 * studio-clock-card: a broadcast studio clock. A ring of sixty dots, the time in red,
 * a countdown to the next calendar event (amber while it is on air), and the event's
 * details beside or under it. The last seconds before a start run as a film leader.
 *
 * MIT licensed.
 */

const CARD_VERSION = "0.3.0";

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
/* Flip clock card, ported from FlipClockWidgetView.swift / ClockTheme  */
/* ------------------------------------------------------------------ */

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** Reinterprets a tint at a given lightness, so one gradient shape serves every theme. */
const shade = (tint, level) => {
  const l = Math.min(Math.max(level, 0), 1);
  return `rgb(${Math.round(tint[0] * l * 255)},${Math.round(tint[1] * l * 255)},${Math.round(tint[2] * l * 255)})`;
};
const grey = (w) => shade([1, 1, 1], w);

/** The two leaf gradients from a base tone, preserving the measured falloff. */
function leaves(tint, top, seamEdge, flare, bottom) {
  return {
    upper: `linear-gradient(to bottom, ${shade(tint, top - 0.055)} 0%, ${shade(tint, top)} 10%, ${shade(tint, top - 0.01)} 78%, ${shade(tint, seamEdge)} 100%)`,
    lower: `linear-gradient(to bottom, ${shade(tint, flare)} 0%, ${shade(tint, flare - 0.025)} 20%, ${shade(tint, (flare + bottom) / 2)} 55%, ${shade(tint, bottom + 0.17)} 85%, ${shade(tint, bottom)} 100%)`,
  };
}

const FLIP_THEMES = (() => {
  const white = [1, 1, 1], cream = [1, 0.96, 0.88];
  const c = leaves(white, 0.955, 0.885, 0.985, 0.61);
  const d = leaves(white, 0.26, 0.2, 0.3, 0.1);
  const a = leaves(cream, 0.94, 0.87, 0.97, 0.58);
  const sl = leaves(white, 0.955, 0.885, 0.985, 0.62);
  return {
    classic: { bg: "#000", standTop: grey(0.72), standBase: grey(0.52), bodyBottom: grey(0.05), ...c,
      seam: grey(0.78), rim: "rgba(255,255,255,.75)", dateText: grey(0.15), digit: grey(0.08),
      primary: "#fff", secondary: "rgba(255,255,255,.75)" },
    charcoal: { bg: "#000", standTop: grey(0.82), standBase: grey(0.62), bodyBottom: grey(0.03), ...d,
      seam: grey(0.34), rim: "rgba(255,255,255,.18)", dateText: grey(0.14), digit: grey(0.93),
      primary: "#fff", secondary: "rgba(255,255,255,.7)" },
    amber: { bg: "rgb(15,13,8)", standTop: "rgb(184,168,140)", standBase: "rgb(133,117,92)", bodyBottom: "rgb(23,18,10)", ...a,
      seam: "rgb(158,140,112)", rim: "rgba(255,255,255,.6)", dateText: "rgb(41,26,10)", digit: "rgb(41,26,10)",
      primary: "rgb(255,237,204)", secondary: "rgba(255,237,204,.7)" },
    slate: { bg: "rgb(20,23,28)", standTop: "rgb(168,176,186)", standBase: "rgb(122,130,140)", bodyBottom: "rgb(13,15,20)", ...sl,
      seam: grey(0.78), rim: "rgba(255,255,255,.75)", dateText: grey(0.12), digit: grey(0.1),
      primary: "#fff", secondary: "rgba(255,255,255,.75)" },
  };
})();

/** Width of two digits in ems, so the pair fits the card whichever face the browser ends up with. */
const FLIP_FACES = {
  condensed: { css: '"Arial Narrow","Roboto Condensed","Helvetica Neue",system-ui,sans-serif', stretch: "condensed", em: 1.0, weight: 500 },
  rounded: { css: 'ui-rounded,"SF Pro Rounded","Nunito","Varela Round",system-ui,sans-serif', stretch: "normal", em: 1.15, weight: 500 },
  serif: { css: 'ui-serif,Georgia,"Times New Roman",serif', stretch: "normal", em: 1.12, weight: 500 },
  monospaced: { css: 'ui-monospace,"JetBrains Mono","SF Mono",Menlo,Consolas,monospace', stretch: "normal", em: 1.25, weight: 500 },
};

const CONDITION_TEXT = {
  "clear-night": "Clear night", cloudy: "Cloudy", exceptional: "Exceptional", fog: "Fog", hail: "Hail",
  lightning: "Thunderstorm", "lightning-rainy": "Thunderstorm, rain", partlycloudy: "Partly cloudy",
  pouring: "Heavy rain", rainy: "Rain", snowy: "Snow", "snowy-rainy": "Sleet", sunny: "Sunny",
  windy: "Windy", "windy-variant": "Windy",
};

/* Multicolour weather glyphs, drawn on a 64x64 grid. */
const SUN = (x, y, r, k = 1) => {
  let rays = "";
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4, r1 = r * 1.45, r2 = r * 1.95;
    rays += `<line x1="${(x + r1 * Math.cos(a)).toFixed(1)}" y1="${(y + r1 * Math.sin(a)).toFixed(1)}" x2="${(x + r2 * Math.cos(a)).toFixed(1)}" y2="${(y + r2 * Math.sin(a)).toFixed(1)}"/>`;
  }
  return `<g stroke="#FFC933" stroke-width="${3.4 * k}" stroke-linecap="round">${rays}</g><circle cx="${x}" cy="${y}" r="${r}" fill="#FFCC33"/>`;
};
const MOON = (x, y, r) =>
  `<path d="M${x + r * 0.35} ${y - r} a${r} ${r} 0 1 0 ${r * 0.9} ${r * 1.45} a${r * 0.8} ${r * 0.8} 0 0 1 ${-r * 0.9} ${-r * 1.45}z" fill="#F2E3A0"/>`;
const CLOUD = (dx, dy, fill = "#EEF1F5", s = 1) =>
  `<path transform="translate(${dx} ${dy}) scale(${s})" d="M18 46a10 10 0 0 1 1-20 14 14 0 0 1 27 4 8 8 0 0 1 0 16z" fill="${fill}"/>`;
const DROPS = (n, heavy) => {
  const xs = n === 4 ? [20, 29, 38, 47] : [24, 34, 44];
  return `<g stroke="#4F9DF5" stroke-width="${heavy ? 4 : 3.2}" stroke-linecap="round">${xs.map((x, i) =>
    `<line x1="${x + 2}" y1="${50 + (i % 2) * 2}" x2="${x - 2}" y2="${58 + (i % 2) * 2}"/>`).join("")}</g>`;
};
const FLAKES = (xs, c = "#DCEBFA") => xs.map((x, i) => `<circle cx="${x}" cy="${53 + (i % 2) * 5}" r="2.6" fill="${c}"/>`).join("");
const BOLT = `<polygon points="35,38 25,53 32,53 29,64 42,46 34.5,46 39,38" fill="#FFD21F"/>`;

function weatherIcon(cond, night) {
  let body;
  switch (cond) {
    case "sunny": body = night ? MOON(32, 32, 15) : SUN(32, 32, 12); break;
    case "clear-night": body = MOON(32, 32, 15); break;
    case "partlycloudy": body = (night ? MOON(24, 24, 11) : SUN(24, 24, 9, 0.8)) + CLOUD(6, 6, "#EEF1F5", 1); break;
    case "rainy": body = CLOUD(0, -4) + DROPS(3, false); break;
    case "pouring": body = CLOUD(0, -4, "#B9C2CC") + DROPS(4, true); break;
    case "snowy": body = CLOUD(0, -4) + FLAKES([22, 32, 42]); break;
    case "snowy-rainy": body = CLOUD(0, -4) + DROPS(3, false).replace("<g", '<g opacity=".9"') + FLAKES([30, 40], "#DCEBFA"); break;
    case "hail": body = CLOUD(0, -4, "#B9C2CC") + FLAKES([20, 30, 40, 50], "#BFE3FF"); break;
    case "fog": body = CLOUD(0, -8) + `<g stroke="#C9D1D9" stroke-width="3.4" stroke-linecap="round"><line x1="12" y1="46" x2="52" y2="46"/><line x1="18" y1="53" x2="58" y2="53"/></g>`; break;
    case "lightning": body = CLOUD(0, -6, "#B9C2CC") + BOLT; break;
    case "lightning-rainy": body = CLOUD(0, -6, "#B9C2CC") + BOLT.replace("35,38 25,53", "30,38 20,53").replace("32,53 29,64 42,46 34.5,46 39,38", "27,53 24,64 37,46 29.5,46 34,38") + DROPS(3, false).replace(/x1="(\d+)"/g, (m, x) => `x1="${+x + 14}"`).replace(/x2="(\d+)"/g, (m, x) => `x2="${+x + 14}"`); break;
    case "windy": case "windy-variant": body = `<g fill="none" stroke="#C9D1D9" stroke-width="3.6" stroke-linecap="round"><path d="M8 26h30a7 7 0 1 0-7-7"/><path d="M8 36h40a7 7 0 1 1-7 7"/><path d="M8 46h20"/></g>`; break;
    default: body = CLOUD(0, 0);
  }
  return `<svg viewBox="0 0 64 64" width="100%" height="100%" aria-hidden="true">${body}</svg>`;
}

const ALLERGEN = `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true"><circle cx="8" cy="9" r="3"/><circle cx="16" cy="7" r="2"/><circle cx="15" cy="15" r="3.5"/><circle cx="6" cy="17" r="1.8"/></svg>`;

/** The offset, in whole steps, of the drifting picture for a burn-in shift: eight points, three minutes each. */
function burnInStep(now) {
  const steps = [[0, 0], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1]];
  return steps[Math.floor(now / 180000) % steps.length];
}

const FLIP_DEFAULTS = {
  entity: "", name: "", theme: "classic", typeface: "condensed", time_format: "auto",
  forecast_days: 5, pollen: [], height: "", burn_in_shift: true,
};

const FLIP_CSS = `
:host { display: block; height: 100%; }
ha-card { overflow: hidden; height: 100%; background: transparent; }
.wrap { position: relative; width: 100%; height: 100%; min-height: 200px; overflow: hidden;
  background: var(--bg); color: var(--primary); font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  container-type: size; }
.plate { position: absolute; z-index: 0; }
.col { position: absolute; z-index: 1; left: 0; right: 0; top: 0; bottom: 0; display: flex; flex-direction: column; align-items: stretch; }
.cards { position: relative; z-index: 2; display: flex; justify-content: center; gap: var(--sp); flex: none; }
.card { position: relative; flex: none; overflow: hidden; box-shadow: 0 0 0 .6px var(--rim) inset; }
.cards { filter: drop-shadow(0 calc(var(--ch) * .035) calc(var(--ch) * .05) rgba(0,0,0,.35)); }
.card .leaf { position: absolute; left: 0; right: 0; height: 50%; }
.card .up { top: 0; background: var(--upper); }
.card .low { bottom: 0; background: var(--lower); }
.card .digits { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  color: var(--digit); line-height: 1; font-variant-numeric: tabular-nums; white-space: nowrap; }
.card .mer { position: absolute; left: 6%; bottom: 10%; color: var(--digit); font-weight: 500; }
.card .seam { position: absolute; left: 0; right: 0; top: 50%; background: var(--seam); }
.date { position: relative; z-index: 1; align-self: center; flex: none; display: flex; justify-content: center;
  border: solid rgba(255,255,255,.45); box-sizing: border-box; }
.date span { display: block; text-align: center; color: var(--dateText); font-weight: 500; white-space: nowrap; overflow: hidden; }
.icon { position: absolute; z-index: 3; left: 50%; transform: translateX(-50%); }
.cap { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.row { display: flex; align-items: flex-start; justify-content: space-between; }
.city { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sum { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.temp { display: flex; align-items: center; }
.hl { display: flex; flex-direction: column; }
.wind { display: flex; align-items: center; }
.wind svg { display: block; }
.pollen { display: flex; gap: .5em; align-items: center; color: var(--secondary); white-space: nowrap; overflow: hidden; }
.days { display: flex; align-items: flex-start; }
.day { flex: 1; display: flex; flex-direction: column; align-items: center; font-weight: 600; }
.day .ico { display: block; }
.note { color: var(--secondary); }
.shift { position: absolute; inset: 0; isolation: isolate; }
`;

class FlipClockCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = null;
    this._hass = null;
    this._built = false;
    this._forecast = [];
    this._sub = null;
    this._subEntity = null;
    this._timer = null;
    this._key = null;
    this._step = null;
  }

  static getStubConfig(hass, entities) {
    const w = (entities || []).find((e) => e.startsWith("weather."));
    return { type: "custom:flip-clock-card", entity: w || "" };
  }

  static getConfigElement() { return document.createElement("flip-clock-card-editor"); }

  getCardSize() { return 4; }

  setConfig(config) {
    if (!config) throw new Error("Invalid configuration");
    const pollen = [].concat(config.pollen || []);
    this._config = { ...FLIP_DEFAULTS, ...config, pollen };
    this._key = null;
    if (this._built) { this._layout(); this._subscribe(); }
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) this._build();
    this._subscribe();
  }

  connectedCallback() {
    if (this._built) { this._subscribe(); this._start(); }
  }

  disconnectedCallback() {
    clearTimeout(this._timer);
    this._timer = null;
    if (this._ro) this._ro.disconnect();
    this._unsubscribe();
  }

  /* ---- forecast subscription ---- */

  _subscribe() {
    const entity = this._config && this._config.entity;
    if (!entity || !this._hass || !this._hass.connection || this._subEntity === entity) return;
    this._unsubscribe();
    this._subEntity = entity;
    this._forecast = [];
    try {
      const p = this._hass.connection.subscribeMessage((ev) => {
        this._forecast = (ev && ev.forecast) || [];
        this._key = null;
      }, { type: "weather/subscribe_forecast", forecast_type: "daily", entity_id: entity });
      this._sub = p;
      p.catch(() => { this._sub = null; });
    } catch (e) { this._sub = null; }
  }

  _unsubscribe() {
    const sub = this._sub;
    this._sub = null;
    this._subEntity = null;
    if (sub) sub.then((u) => typeof u === "function" && u()).catch(() => {});
  }

  /* ---- DOM ---- */

  _build() {
    this.shadowRoot.innerHTML = `<style>${FLIP_CSS}</style>
      <ha-card><div class="wrap"><div class="shift">
        <div class="plate"></div>
        <div class="col">
          <div class="cards">
            <div class="card h"><div class="leaf up"></div><div class="leaf low"></div><div class="digits"></div><div class="mer"></div><i class="seam"></i></div>
            <div class="card m"><div class="leaf up"></div><div class="leaf low"></div><div class="digits"></div><i class="seam"></i></div>
          </div>
          <div class="date"><span class="wd"></span><span class="dt"></span></div>
          <div class="cap"></div>
        </div>
        <div class="icon"></div>
      </div></div></ha-card>`;
    const r = this.shadowRoot;
    this._wrap = r.querySelector(".wrap");
    this._shiftEl = r.querySelector(".shift");
    this._plate = r.querySelector(".plate");
    this._col = r.querySelector(".col");
    this._cards = r.querySelector(".cards");
    this._cardEls = [r.querySelector(".card.h"), r.querySelector(".card.m")];
    this._date = r.querySelector(".date");
    this._cap = r.querySelector(".cap");
    this._icon = r.querySelector(".icon");
    this._ro = new ResizeObserver(() => { this._key = null; this._layout(); });
    this._ro.observe(this);
    this._built = true;
    this._layout();
    this._start();
  }

  _theme() { return FLIP_THEMES[this._config.theme] || FLIP_THEMES.classic; }

  /** Sizes follow the widget's: everything is derived from the card's width and height. */
  _layout() {
    if (!this._built || !this._config) return;
    const cfg = this._config;
    this._wrap.style.height = cfg.height ? String(cfg.height) : "";
    const w = this._wrap.clientWidth || this.clientWidth || 400;
    const h = this._wrap.clientHeight || this.clientHeight || 300;
    const ratio = w / h;
    const days = Math.max(0, Math.min(7, Number(cfg.forecast_days) || 0));
    const mode = days > 0 && h >= 280 && ratio < 3 ? "large" : ratio >= 1.5 ? "medium" : "small";
    let ch, cw, icon, inset = w * 0.045;
    if (mode === "large") {
      ch = Math.min(h * 0.38, w * 0.4);
      cw = ratio >= 1.5 ? Math.min(ch * 1.9, w * 0.4) : ch * 1.02;
      icon = h * 0.19;
    } else if (mode === "medium") {
      ch = Math.min(h * 0.55, w * 0.4); cw = ch * 1.02; icon = h * 0.3;
    } else {
      inset = w * 0.015;
      const avail = w - inset * 2;
      ch = Math.min(h * 0.55, avail / (2 * 0.9 + 0.1));
      cw = (avail - ch * 0.1) / 2;
      icon = h * 0.21;
    }
    const top = h * 0.05, overhang = ch * 0.28, rowH = ch * 0.28, visible = rowH * 0.75, tuck = rowH * 0.25;
    const slabTop = top + overhang, slabH = Math.max(1, h - slabTop);
    const dateLine = Math.min(0.95, (top + ch + visible - slabTop) / slabH);
    const t = this._theme();
    const face = FLIP_FACES[cfg.typeface] || FLIP_FACES.condensed;
    const wrap = this._wrap;
    for (const [k, v] of Object.entries({ bg: t.bg, upper: t.upper, lower: t.lower, seam: t.seam, rim: t.rim,
      dateText: t.dateText, digit: t.digit, primary: t.primary, secondary: t.secondary, ch: ch + "px", sp: ch * 0.1 + "px" })) {
      wrap.style.setProperty("--" + k, v);
    }
    Object.assign(this._plate.style, {
      left: ch * 0.032 + "px", right: ch * 0.032 + "px", top: slabTop + "px", bottom: ch * 0.032 + "px",
      borderRadius: ch * 0.16 + "px",
      background: `linear-gradient(to bottom, ${t.standTop} 0%, ${t.standBase} ${dateLine * 100}%, ${t.bodyBottom} ${Math.min(1, dateLine + 0.05) * 100}%, ${t.bodyBottom} 100%)`,
    });
    Object.assign(this._col.style, { paddingTop: top + "px", paddingLeft: inset + "px", paddingRight: inset + "px" });
    const digit = Math.min(ch * 0.86, (cw * 0.92) / face.em);
    this._cardEls.forEach((c) => {
      Object.assign(c.style, { width: cw + "px", height: ch + "px", borderRadius: ch * 0.14 + "px" });
      Object.assign(c.querySelector(".digits").style, { fontFamily: face.css, fontStretch: face.stretch, fontWeight: face.weight, fontSize: digit + "px" });
      const seam = c.querySelector(".seam");
      seam.style.height = Math.max(0.5, ch * 0.005) + "px";
    });
    this._cardEls[0].querySelector(".mer").style.fontSize = ch * 0.15 + "px";
    Object.assign(this._date.style, {
      width: cw * 2 + ch * 0.1 + "px", height: rowH + "px", marginTop: -tuck + "px",
      borderWidth: Math.max(0.5, visible * 0.03) + "px", borderRadius: visible * 0.42 + "px",
      paddingTop: tuck / 2 + "px", gap: ch * 0.1 + "px", alignItems: "center",
    });
    this._date.querySelectorAll("span").forEach((s) => {
      Object.assign(s.style, { width: cw + "px", fontSize: visible * 0.55 + "px", letterSpacing: visible * 0.035 + "px" });
    });
    Object.assign(this._icon.style, {
      width: icon * 1.3 + "px", height: icon + "px",
      top: top + ch + rowH * 0.9 - icon * 0.3 + "px",
    });
    this._dim = { w, h, ch, cw, mode, days: mode === "large" ? (ratio >= 1.5 ? Math.min(7, days) : Math.min(5, days)) : 0, visible };
    this._key = null;
    this._shiftStep = null;
  }

  _start() {
    clearTimeout(this._timer);
    const tick = () => {
      this._update();
      this._timer = setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
    };
    tick();
  }

  _lang() { return (this._hass && this._hass.locale && this._hass.locale.language) || undefined; }

  _uses12h() {
    const f = this._config.time_format;
    if (f === "12") return true;
    if (f === "24") return false;
    const fmt = this._hass && this._hass.locale && this._hass.locale.time_format;
    if (fmt === "12") return true;
    if (fmt === "24") return false;
    try { return new Intl.DateTimeFormat(this._lang(), { hour: "numeric" }).resolvedOptions().hour12 === true; }
    catch (e) { return false; }
  }

  /** What the weather entity says now, in the shape the layout draws. */
  _weather() {
    const cfg = this._config;
    if (!cfg.entity || !this._hass) return { none: true };
    const st = this._hass.states[cfg.entity];
    if (!st || st.state === "unavailable" || st.state === "unknown") {
      return { error: st ? "The weather entity is unavailable." : `Entity ${cfg.entity} not found.` };
    }
    const a = st.attributes || {};
    const sun = this._hass.states["sun.sun"];
    const night = st.state === "clear-night" || (sun && sun.state === "below_horizon");
    let summary;
    try { summary = this._hass.formatEntityState ? this._hass.formatEntityState(st) : null; } catch (e) { summary = null; }
    const today = new Date().toDateString();
    const daily = (this._forecast || []).filter((f) => f.datetime && new Date(f.datetime).setHours(23, 59, 59) >= Date.now() - 1000)
      .map((f) => ({ date: new Date(f.datetime), cond: f.condition, high: f.temperature, low: f.templow }));
    const todayItem = daily.find((d) => d.date.toDateString() === today) || daily[0];
    const wind = Number(a.wind_speed);
    return {
      city: cfg.name || a.friendly_name || "",
      temp: Number(a.temperature),
      high: todayItem && Number.isFinite(Number(todayItem.high)) ? Number(todayItem.high) : null,
      low: todayItem && Number.isFinite(Number(todayItem.low)) ? Number(todayItem.low) : null,
      summary: summary || CONDITION_TEXT[st.state] || st.state,
      cond: st.state, night,
      wind: Number.isFinite(wind) ? wind : null, windUnit: a.wind_speed_unit || "",
      bearing: Number.isFinite(Number(a.wind_bearing)) ? Number(a.wind_bearing) : null,
      daily,
    };
  }

  _pollen() {
    const out = [];
    for (const id of this._config.pollen) {
      const st = this._hass && this._hass.states[id];
      if (!st || ["unavailable", "unknown", "none", "0", ""].includes(String(st.state).toLowerCase())) continue;
      const label = String((st.attributes && st.attributes.friendly_name) || id)
        .replace(/^pollen[\s_-]*/i, "").replace(/[\s_-]*pollen$/i, "").trim() || id;
      const n = Number(st.state);
      const value = Number.isFinite(n) ? String(Math.round(n)) : String(st.state).toLowerCase();
      if (Number.isFinite(n) && n < 0.5) continue;
      out.push(`${label} ${value}`);
    }
    return out;
  }

  _update() {
    if (!this._built || !this._config || !this._dim) return;
    const now = new Date();
    const d = this._dim;
    const lang = this._lang();

    // Cards and date
    let hours = now.getHours(), mer = "";
    if (this._uses12h()) { mer = hours < 12 ? "AM" : "PM"; hours = hours % 12 || 12; }
    this._cardEls[0].querySelector(".digits").textContent = pad2(hours);
    this._cardEls[0].querySelector(".mer").textContent = mer;
    this._cardEls[1].querySelector(".digits").textContent = pad2(now.getMinutes());
    const wd = now.toLocaleDateString(lang, { weekday: "short" }).toUpperCase();
    const mo = now.toLocaleDateString(lang, { month: "short" }).replace(/\.$/, "").toUpperCase();
    const spans = this._date.querySelectorAll("span");
    spans[0].textContent = wd;
    spans[1].textContent = `${mo} ${pad2(now.getDate())}`;

    // Weather
    const wx = this._weather();
    const pollen = d.mode === "large" ? this._pollen() : [];
    const key = JSON.stringify([wx, pollen, d.mode, d.w, d.h, now.toDateString()]);
    if (key !== this._key) {
      this._key = key;
      this._icon.innerHTML = wx.cond ? weatherIcon(wx.cond, wx.night) : "";
      this._cap.innerHTML = this._caption(wx, pollen, lang);
    }
    this._shift(now.getTime());
  }

  _temp(n) { return Number.isFinite(n) ? `${Math.round(n)}\u00b0` : "\u2013"; }

  _tempBlock(wx, scale) {
    const hl = wx.high != null && wx.low != null
      ? `<div class="hl" style="font-size:${scale * 0.42}px"><span>H: ${this._temp(wx.high)}</span><span>L: ${this._temp(wx.low)}</span></div>` : "";
    return `<div class="temp" style="gap:${scale * 0.1}px"><span style="font-size:${scale}px">${this._temp(wx.temp)}</span>${hl}</div>`;
  }

  _caption(wx, pollen, lang) {
    const { w, h, mode, ch, visible } = this._dim;
    if (wx.none) return "";
    if (wx.error) {
      const sz = h * (mode === "medium" ? 0.09 : mode === "small" ? 0.075 : 0.05);
      return `<div style="padding-top:${h * 0.05}px"><div style="font-size:${sz}px;font-weight:600">Weather unavailable</div>
        <div class="note" style="font-size:${sz * 0.85}px">${esc(wx.error)}</div></div>`;
    }
    if (mode === "small") {
      return `<div style="display:flex;justify-content:center;padding-top:${h * 0.21 * 0.72}px">${this._tempBlock(wx, h * 0.145)}</div>`;
    }
    if (mode === "medium") {
      return `<div class="row" style="align-items:center;padding-top:${h * 0.035}px">
        <div style="min-width:0;display:flex;flex-direction:column;gap:${h * 0.01}px">
          <div class="city" style="font-size:${h * 0.078}px">${esc(wx.city)}</div>
          <div class="sum" style="font-size:${h * 0.07}px">${esc(wx.summary)}</div>
        </div>${this._tempBlock(wx, h * 0.125)}</div>`;
    }
    // large
    const windSz = h * 0.036;
    const wind = wx.wind != null
      ? `<div class="wind" style="font-size:${windSz}px;gap:${windSz * 0.25}px">
          ${wx.bearing != null ? `<svg viewBox="0 0 24 24" width="${windSz * 0.9}" height="${windSz * 0.9}" style="transform:rotate(${wx.bearing + 180}deg)"><path d="M12 3v18M5 10l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>` : ""}
          <span>${(Math.round(wx.wind * 10) / 10)} ${esc(wx.windUnit)}</span></div>` : "";
    const ps = h * 0.034;
    const pollenRow = pollen.length || this._config.pollen.length
      ? `<div class="pollen" style="font-size:${ps}px;padding-bottom:${h * 0.018}px">${ALLERGEN}${
        pollen.length ? pollen.slice(0, 3).map((p) => `<span>${esc(p)}</span>`).join("") : "<span>No pollen</span>"}</div>` : "";
    const days = wx.daily.slice(0, this._dim.days);
    const fl = h * 0.038, fi = h * 0.065;
    const forecast = days.length
      ? `<div class="days">${days.map((x) => `<div class="day" style="gap:${fi * 0.16}px">
          <span style="font-size:${fl}px">${esc(x.date.toLocaleDateString(lang, { weekday: "short" }))}</span>
          <span class="ico" style="width:${fi}px;height:${fi}px">${weatherIcon(x.cond, false)}</span>
          <span style="font-size:${fl}px">${this._temp(x.low)}/${this._temp(x.high)}</span></div>`).join("")}</div>` : "";
    return `<div style="display:flex;flex-direction:column;height:100%">
      <div class="row" style="padding-top:${h * 0.025}px">
        <div style="min-width:0;display:flex;flex-direction:column;gap:${h * 0.008}px">
          <div class="city" style="font-size:${h * 0.042}px">${esc(wx.city)}</div>
          <div class="sum" style="font-size:${h * 0.038}px">${esc(wx.summary)}</div>${wind}
        </div>${this._tempBlock(wx, h * 0.07)}</div>
      <div style="flex:1"></div>${pollenRow}${forecast}<div style="flex:1"></div></div>`;
  }

  /** A few pixels' drift every three minutes, against burn-in on AMOLED panels. */
  _shift(now) {
    const on = this._config.burn_in_shift !== false;
    const [x, y] = on ? burnInStep(now) : [0, 0];
    const key = `${x},${y},${this._dim.w}`;
    if (key === this._shiftStep) return;
    this._shiftStep = key;
    const px = Math.max(1, Math.round(Math.min(this._dim.w, this._dim.h) * 0.008));
    this._shiftEl.style.transform = x || y ? `translate(${x * px}px, ${y * px}px)` : "";
  }
}

class FlipClockCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { ...FLIP_DEFAULTS, ...config };
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
    const opts = (list) => ({ select: { mode: "dropdown", options: list.map(([value, label]) => ({ value, label })) } });
    this._form.hass = this._hass;
    this._form.schema = [
      { name: "entity", label: "Weather entity", selector: { entity: { domain: "weather" } } },
      { name: "name", label: "Place name (empty = the entity's name)", selector: { text: {} } },
      { name: "theme", label: "Theme", selector: opts([["classic", "Classic"], ["charcoal", "Charcoal"], ["amber", "Amber"], ["slate", "Slate"]]) },
      { name: "typeface", label: "Digits", selector: opts([["condensed", "Condensed"], ["rounded", "Rounded"], ["serif", "Serif"], ["monospaced", "Monospaced"]]) },
      { name: "time_format", label: "Hours", selector: opts([["auto", "As in Home Assistant"], ["24", "24-hour"], ["12", "12-hour"]]) },
      { name: "forecast_days", label: "Forecast days (0 = none)", selector: { number: { min: 0, max: 7, mode: "box" } } },
      { name: "pollen", label: "Pollen sensors", selector: { entity: { domain: "sensor", multiple: true } } },
      { name: "burn_in_shift", label: "Shift the picture a few pixels now and then (AMOLED burn-in)", selector: { boolean: {} } },
      { name: "height", label: "Height (CSS length, e.g. 90vh; empty = fill)", selector: { text: {} } },
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
if (!customElements.get("flip-clock-card")) {
  customElements.define("flip-clock-card", FlipClockCard);
  customElements.define("flip-clock-card-editor", FlipClockCardEditor);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: "studio-clock-card",
  name: "Studio Clock",
  description: "A broadcast studio clock: a ring of dots, the time, and a countdown to your next calendar event.",
  preview: false,
});
window.customCards.push({
  type: "flip-clock-card",
  name: "Flip Clock",
  description: "Flip-clock cards with the date, and the weather from a Home Assistant weather entity.",
  preview: false,
});

console.info(`%c CLOCK-CARDS %c ${CARD_VERSION} `, "background:#F03329;color:#fff", "background:#222;color:#fff");
