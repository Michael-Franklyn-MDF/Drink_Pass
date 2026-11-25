import { useState } from "react";
import {
  addGuests, formatTime, IDENTIFIER_TYPES, INITIAL_VOUCHERS, localDate, useEvent,
} from "./eventStore.js";
import StockDialog from "./StockDialog.jsx";
import { Dialog, Screen, ScreenTitle, TextField } from "./ui.jsx";

const TABS = { guests: ["Guest list", "Guests"], stock: ["Drinks and stock", "Stock"], orders: ["Served drinks", "Orders"] };
const IMPORT_COLUMNS = ["Full name", "Identifier", "Department", "Role", "Identifier type", "Vouchers"];
const ORDER_COLUMNS = ["Drink", "Guest", "Identifier", "Department", "Date", "Time", "Bartender"];

function ChoiceField({ label, name, options }) {
  return (
    <label className="admin-field">
      <span className="field-label">{label}</span>
      <select className="text-field" name={name}>
        {options.map(([value, title]) => <option key={value} value={value}>{title}</option>)}
      </select>
    </label>
  );
}

function guestProfile(values) {
  const fullName = String(values["Full name"] ?? "").trim();
  const identifier = String(values.Identifier ?? "").trim();
  const department = String(values.Department ?? "").trim();
  const role = String(values.Role ?? "staff").trim().toLowerCase() || "staff";
  const inputType = String(values["Identifier type"] ?? "").trim().toLowerCase() || "staff id";
  const identifierType = IDENTIFIER_TYPES.find((type) => type.toLowerCase() === inputType);
  const remaining = values.Vouchers === "" || values.Vouchers == null ? INITIAL_VOUCHERS : Number(values.Vouchers);
  if (!fullName || !identifier || !department || !identifierType ||
      !["staff", "manager"].includes(role) || !Number.isSafeInteger(remaining) || remaining < 0) return null;
  return { fullName, identifier, department, role, identifierType, remaining };
}

async function readGuests(file) {
  const { readSheet } = await import("read-excel-file/browser");
  const rows = await readSheet(file, 1);
  const [headings, ...body] = rows;
  const columns = headings?.map((value) => String(value ?? "").trim().toLowerCase()) ?? [];
  if (!IMPORT_COLUMNS.slice(0, 3).every((key) => columns.includes(key.toLowerCase()))) {
    throw new Error("Include Full name, Identifier and Department columns in the first row.");
  }
  const profiles = [];
  for (const [index, row] of body.entries()) {
    if (row.every((value) => value == null || value === "")) continue;
    const values = Object.fromEntries(IMPORT_COLUMNS.map((key) => [key, row[columns.indexOf(key.toLowerCase())]]));
    const profile = guestProfile(values);
    if (!profile) throw new Error(`Check guest details on row ${index + 2}.`);
    profiles.push(profile);
  }
  if (!profiles.length) throw new Error("The spreadsheet contains no guests.");
  return profiles;
}

async function downloadWorkbook(rows, name) {
  const { default: writeWorkbook } = await import("write-excel-file/browser");
  await writeWorkbook(rows).toFile(name);
}

function AdminDialog({ panel, close, notify }) {
  const isImport = panel.type === "import";
  const title = isImport ? "Import guests" : "Add guest";
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    setSaving(true);
    setError("");

    try {
      if (isImport) {
        let profiles;
        try {
          profiles = await readGuests(values.workbook);
        } catch (issue) {
          const message = issue.message;
          throw new Error(/^(Include|Check guest details|The spreadsheet)/.test(message)
            ? message : "Couldn’t read this file. Choose an Excel (.xlsx) workbook.");
        }
        const added = await addGuests(profiles);
        notify(`${added} imported. ${profiles.length - added} duplicates skipped.`);
      } else {
        const profile = guestProfile(values);
        if (!profile) throw new Error("Complete the guest details.");
        if (!await addGuests([profile])) throw new Error("A guest with this identifier already exists.");
        notify("Guest added.");
      }
      close();
    } catch (issue) {
      setError(issue.message || "Couldn’t save your changes. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog titleId="admin-dialog-title" onClose={() => { if (!saving) close(); }} className="bottom-sheet admin-dialog">
      <div className="sheet-handle" aria-hidden="true" />
      <h2 id="admin-dialog-title">{title}</h2>
      <form className="admin-form" onSubmit={submit}>
        {isImport ? (
          <>
            <p className="screen-description">Upload an Excel workbook using the guest template. Existing guests are skipped.</p>
            <TextField label="Excel workbook" name="workbook" type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" />
            <button type="button" className="text-link" onClick={async () => {
              try {
                await downloadWorkbook([IMPORT_COLUMNS], "drink-pass-guest-template.xlsx");
              } catch {
                setError("Couldn’t download the template.");
              }
            }}>Download guest template</button>
          </>
        ) : (
          <>
            <TextField label="Full name" name="Full name" />
            <ChoiceField label="Identifier type" name="Identifier type" options={IDENTIFIER_TYPES.map((type) => [type, type])} />
            <TextField label="Identifier" name="Identifier" />
            <TextField label="Department" name="Department" />
            <ChoiceField label="Role" name="Role" options={[["staff", "Staff"], ["manager", "Manager"]]} />
          </>
        )}
        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="admin-form-actions">
          <button className="button button-primary" disabled={saving}>{isImport ? "Import" : "Save"}</button>
          <button className="button button-secondary" type="button" onClick={close} disabled={saving}>Cancel</button>
        </div>
      </form>
    </Dialog>
  );
}

function AdminNav({ active, select, add }) {
  return (
    <div className="admin-nav-group">
      <nav className="admin-nav" aria-label="Admin sections">
        {Object.entries(TABS).map(([id, [, label]]) => (
          <button key={id} type="button" aria-label={label} aria-current={id === active ? "page" : undefined}
            onClick={() => select(id)}>
            <img src={`/assets/${id}${id === active ? "-active" : ""}.svg`} alt="" />
            {id === active && <span>{label}</span>}
          </button>
        ))}
      </nav>
      {active !== "orders" && (
        <button type="button" className="admin-add" aria-label={active === "guests" ? "Add guest" : "Add drink"} onClick={add}>
          <img src="/assets/add.svg" alt="" />
        </button>
      )}
    </div>
  );
}

export default function Admin() {
  const data = useEvent();
  const [active, setActive] = useState("guests");
  const [query, setQuery] = useState("");
  const [panel, setPanel] = useState(null);
  const [date, setDate] = useState("today");
  const [bartender, setBartender] = useState("all");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const today = localDate(Date.now());
  const dates = [...new Set(data.orders.map((order) => localDate(order.scannedAt)))].sort().reverse();
  const bartenders = [...new Set(data.orders.map((order) => order.bartender))].sort();
  const orders = data.orders.filter((order) =>
    (date === "all" || localDate(order.scannedAt) === (date === "today" ? today : date)) &&
    (bartender === "all" || bartender === order.bartender),
  );
  const search = query.trim().toLowerCase();
  const guests = data.guests.filter((guest) => [guest.fullName, guest.identifier, guest.department, guest.role]
    .some((value) => value.toLowerCase().includes(search)));
  const orderRows = orders.map((order) => [
    order.drink, order.guest.fullName, order.guest.identifier, order.guest.department,
    localDate(order.scannedAt), formatTime(order.scannedAt), order.bartender,
  ]);

  async function exportSpreadsheet() {
    setError("");
    try {
      await downloadWorkbook([ORDER_COLUMNS, ...orderRows], "drink-pass-served-drinks.xlsx");
    } catch {
      setError("Couldn’t export the spreadsheet. Try again.");
    }
  }

  return (
    <>
      <Screen role="Admin" className={`admin-screen admin-${active}`}>
        <div className="screen-content">
          <ScreenTitle>{TABS[active][0]}</ScreenTitle>
          {active === "guests" && (
            <>
              <div className="admin-search">
                <input className="text-field" type="search" aria-label="Search guests" placeholder="Search guests"
                  value={query} onChange={(event) => setQuery(event.target.value)} />
                <button className="button button-secondary" onClick={() => setPanel({ type: "import" })}>Import</button>
              </div>
              <ul className="admin-list">
                {guests.map((guest) => <li key={guest.id}>{guest.fullName} · {guest.role === "manager" ? "Manager" : `${guest.remaining} left`}</li>)}
              </ul>
              {!guests.length && <p className="screen-description">No guests match your search.</p>}
            </>
          )}
          {active === "stock" && (
            <ul className="admin-list">
              {data.drinks.map((drink) => (
                <li key={drink.id}>
                  <button onClick={() => setPanel({ type: "edit-stock", drink })}>
                    {drink.name} · {drink.stock} {drink.stock === 1 ? "bottle" : "bottles"}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {active === "orders" && (
            <>
              <div className="admin-filters">
                <select aria-label="Filter by date" value={date} onChange={(event) => setDate(event.target.value)}>
                  <option value="today">Date: Today</option>
                  <option value="all">Date: All</option>
                  {dates.filter((item) => item !== today).map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
                <select aria-label="Filter by bartender" value={bartender} onChange={(event) => setBartender(event.target.value)}>
                  <option value="all">Bartender: All</option>
                  {bartenders.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              </div>
              <ul className="admin-list order-list">
                {orders.map((order) => (
                  <li key={order.id}>
                    <div>{order.drink} · {formatTime(order.scannedAt)}</div>
                    <div>{order.guest.fullName} · {order.guest.identifier}</div>
                  </li>
                ))}
              </ul>
              {!orders.length && <p className="screen-description">No served drinks match these filters.</p>}
            </>
          )}
          {notice && <p className="screen-description" role="status">{notice}</p>}
          {error && <p className="field-error" role="alert">{error}</p>}
        </div>
        <div className="screen-actions admin-actions">
          {active === "orders" && (
            <div className="export-actions">
              <button className="button button-primary" onClick={() => window.print()}>Export PDF</button>
              <button className="button button-secondary" onClick={exportSpreadsheet}>Export spreadsheet</button>
            </div>
          )}
          <AdminNav active={active} select={(id) => { setActive(id); setNotice(""); setError(""); }}
            add={() => setPanel({ type: active === "guests" ? "add-guest" : "add-stock" })} />
        </div>
      </Screen>
      {active === "orders" && (
        <section className="print-orders">
          <h1>Drink Pass · Served drinks</h1>
          <p>{date === "today" ? today : date === "all" ? "All dates" : date} · {bartender === "all" ? "All bartenders" : bartender}</p>
          <table>
            <thead><tr>{ORDER_COLUMNS.map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
            <tbody>{orderRows.map((row, index) => (
              <tr key={orders[index].id}>{row.map((cell, column) => <td key={ORDER_COLUMNS[column]}>{cell}</td>)}</tr>
            ))}</tbody>
          </table>
        </section>
      )}
      {panel && (panel.type === "edit-stock" || panel.type === "add-stock"
        ? <StockDialog action={panel.drink ? "update" : "add"} drink={panel.drink}
            notify={setNotice} close={() => setPanel(null)} />
        : <AdminDialog panel={panel} notify={setNotice} close={() => setPanel(null)} />)}
    </>
  );
}
