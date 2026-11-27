import { useRef, useState } from "react";
import { INITIAL_VOUCHERS, localDate } from "./eventStore.js";
import { createEvent } from "./lib/liveEventStore.js";
import { Dialog, TextField } from "./ui.jsx";

function eventLink(role, event) {
  const url = new URL("/", window.location.origin);
  url.searchParams.set("backend", "1");
  url.searchParams.set("role", role);
  if (!event.isDefault) url.searchParams.set("event", event.id);
  return url.href;
}

export function EventPicker({ event, events, onCreate }) {
  return (
    <div className="event-picker">
      <div className="event-picker-controls">
        <div className="admin-field">
          <label className="field-label" htmlFor="admin-event">Event</label>
          <select id="admin-event" className="text-field" value={event.id} onChange={({ target }) => {
            const selected = events.find(({ id }) => id === target.value);
            if (selected) window.location.assign(eventLink("admin", selected));
          }}>
            {events.map(({ id, name, date }) => <option key={id} value={id}>{name} · {date}</option>)}
          </select>
        </div>
        <button className="button button-secondary" type="button" onClick={onCreate}>New event</button>
      </div>
      {event.usesCards
        ? <p className="screen-description">Guests use physical cards. Bartenders use the Flutter app.</p>
        : <a className="text-link" href={eventLink("bartender", event)}>Web bartender (rehearsal)</a>}
    </div>
  );
}

export function EventDialog({ close }) {
  const requestId = useRef(null);
  const pending = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(event) {
    event.preventDefault();
    if (pending.current) return;
    const values = new FormData(event.currentTarget);
    const name = values.get("name").trim();
    const date = values.get("date");
    if (!name || !date) {
      setError("Enter an event name and date.");
      return;
    }
    pending.current = true;
    setSaving(true);
    setError("");
    try {
      requestId.current ??= crypto.randomUUID();
      const created = await createEvent(requestId.current, name, date, INITIAL_VOUCHERS);
      window.location.assign(eventLink("admin", created));
    } catch (issue) {
      setError(issue.message || "Couldn’t create the event. Try again.");
      pending.current = false;
      setSaving(false);
    }
  }

  return (
    <Dialog titleId="event-dialog-title" onClose={() => { if (!saving) close(); }} className="bottom-sheet admin-dialog">
      <div className="sheet-handle" aria-hidden="true" />
      <h2 id="event-dialog-title">New event</h2>
      <form className="admin-form" onSubmit={submit}>
        <TextField label="Event name" name="name" maxLength={100} />
        <TextField label="Event date" name="date" type="date" defaultValue={localDate(Date.now())} />
        <p className="screen-description">Staff start with five drinks. Managers have an uncapped allowance.</p>
        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="admin-form-actions">
          <button className="button button-primary" disabled={saving}>{saving ? "Creating…" : "Create event"}</button>
          <button className="button button-secondary" type="button" disabled={saving} onClick={close}>Cancel</button>
        </div>
      </form>
    </Dialog>
  );
}
