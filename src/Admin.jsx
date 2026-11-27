import { useState } from "react";
import {
  addGuests, backendMode, formatTime, IDENTIFIER_TYPES, INITIAL_VOUCHERS, localDate, useEvent,
} from "./eventStore.js";
import BottomNav from "./BottomNav.jsx";
import { EventDialog, EventPicker } from "./AdminEventSetup.jsx";
import { cardReport, cardReportSheets, COUNT_COLUMNS, DETAIL_COLUMNS } from "./cardReport.js";
import StockDialog from "./StockDialog.jsx";
import { Dialog, Screen, ScreenTitle, TextField } from "./ui.jsx";

const TABS = { guests: ["Guest list", "Guests"], stock: ["Drinks and stock", "Stock"], orders: ["Served drinks", "Orders"] };
const ADMIN_NAV_TABS = Object.entries(TABS).map(([id, [, label]]) => ({ id, label }));
const CARD_NAV_TABS = ADMIN_NAV_TABS.filter(({ id }) => id !== "stock");
const IMPORT_COLUMNS = ["Full name", "Identifier", "Department", "Guest type", "Identifier type", "Drink allowance"];
const LEGACY_COLUMNS = { "guest type": "role", "drink allowance": "vouchers" };
const ORDER_COLUMNS = ["Drink", "Guest", "Date", "Time", "Bartender"];

function ChoiceField({ label, name, options, ...props }) {
  return (
    <label className="admin-field">
      <span className="field-label">{label}</span>
      <select className="text-field" name={name} {...props}>
        {options.map(([value, title]) => <option key={value} value={value}>{title}</option>)}
      </select>
    </label>
  );
}

function guestProfile(values, defaultVouchers, cardEvent) {
  const fullName = String(values["Full name"] ?? "").trim();
  const identifier = String(values["Staff ID"] ?? values.Identifier ?? "").trim();
  const department = String(values.Department ?? "").trim();
  const role = String(values["Guest type"] ?? "staff").trim().toLowerCase() || "staff";
  const inputType = String(values["Identifier type"] ?? "").trim().toLowerCase() || "staff id";
  const identifierType = IDENTIFIER_TYPES.find((type) => type.toLowerCase() === inputType);
  const allowance = values["Drink allowance"];
  const remaining = role === "manager" || String(allowance ?? "").trim() === "" ? defaultVouchers : Number(allowance);
  if (!fullName || !identifier || !department || !identifierType || (cardEvent && identifierType !== "Staff ID") ||
      !["staff", "manager"].includes(role) || !Number.isInteger(remaining) || remaining < 0 || remaining > 2147483647) return null;
  return { fullName, identifier, department, role, identifierType, remaining };
}

async function readGuests(file, defaultVouchers, cardEvent) {
  const { readSheet } = await import("read-excel-file/browser");
  const rows = await readSheet(file, 1);
  const [headings, ...body] = rows;
  const columns = headings?.map((value) => String(value ?? "").trim().toLowerCase()) ?? [];
  if (!columns.includes("full name") || !columns.includes("department") ||
      !(columns.includes("identifier") || columns.includes("staff id"))) {
    throw new Error(`Include Full name, ${cardEvent ? "Staff ID" : "Identifier"} and Department columns in the first row.`);
  }
  const profiles = [];
  for (const [index, row] of body.entries()) {
    if (row.every((value) => value == null || value === "")) continue;
    const values = Object.fromEntries(IMPORT_COLUMNS.map((key) => {
      const heading = key.toLowerCase();
      const column = columns.includes(heading) ? heading : LEGACY_COLUMNS[heading];
      return [key, row[columns.indexOf(column)]];
    }));
    values["Staff ID"] = row[columns.indexOf("staff id")];
    const profile = guestProfile(values, defaultVouchers, cardEvent);
    if (!profile) throw new Error(`Check guest details on row ${index + 2}.`);
    profiles.push(profile);
  }
  if (!profiles.length) throw new Error("The spreadsheet contains no guests.");
  return profiles;
}

async function downloadWorkbook(data, name) {
  const { default: writeWorkbook } = await import("write-excel-file/browser");
  await writeWorkbook(data).toFile(name);
}

function AdminDialog({ panel, close, notify, defaultVouchers, cardEvent }) {
  const isImport = panel.type === "import";
  const title = isImport ? "Import guests" : "Add guest";
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [guestType, setGuestType] = useState("staff");

  async function submit(event) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    setSaving(true);
    setError("");

    try {
      if (isImport) {
        let profiles;
        try {
          profiles = await readGuests(values.workbook, defaultVouchers, cardEvent);
        } catch (issue) {
          const message = issue.message;
          throw new Error(/^(Include|Check guest details|The spreadsheet)/.test(message)
            ? message : "Couldn’t read this file. Choose an Excel (.xlsx) workbook.");
        }
        const added = await addGuests(profiles);
        notify(`${added} imported. ${profiles.length - added} duplicates skipped.`);
      } else {
        const profile = guestProfile(values, defaultVouchers, cardEvent);
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
                const columns = cardEvent
                  ? IMPORT_COLUMNS.filter((column) => column !== "Identifier type")
                    .map((column) => column === "Identifier" ? "Staff ID" : column)
                  : IMPORT_COLUMNS;
                await downloadWorkbook([columns], "drink-pass-guest-template.xlsx");
              } catch {
                setError("Couldn’t download the template.");
              }
            }}>Download guest template</button>
          </>
        ) : (
          <>
            <TextField label="Full name" name="Full name" />
            {!cardEvent && (
              <ChoiceField label="Identifier type" name="Identifier type" options={IDENTIFIER_TYPES.map((type) => [type, type])} />
            )}
            <TextField label={cardEvent ? "Staff ID" : "Identifier"} name={cardEvent ? "Staff ID" : "Identifier"} />
            <TextField label="Department" name="Department" />
            <ChoiceField label="Guest type" name="Guest type" value={guestType}
              onChange={(event) => setGuestType(event.target.value)} options={[["staff", "Staff"], ["manager", "Manager"]]} />
            {backendMode && guestType === "staff" && (
              <TextField label="Drink allowance" name="Drink allowance" type="number"
                min="0" max="2147483647" step="1" defaultValue={defaultVouchers} />
            )}
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

export default function Admin() {
  const data = useEvent();
  const cardEvent = !backendMode || data.event?.usesCards === true;
  const [active, setActive] = useState("guests");
  const [query, setQuery] = useState("");
  const [panel, setPanel] = useState(null);
  const [date, setDate] = useState(backendMode ? "all" : "today");
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
    order.drink, order.guest.fullName,
    localDate(order.scannedAt), formatTime(order.scannedAt), order.bartender,
  ]);
  const report = cardEvent ? cardReport(orders) : null;

  async function exportSpreadsheet() {
    setError("");
    try {
      const eventId = data.event ? `-${data.event.id.slice(0, 8)}` : "";
      await downloadWorkbook(report ? cardReportSheets(report) : [ORDER_COLUMNS, ...orderRows],
        `drink-pass-served-drinks${eventId}.xlsx`);
    } catch {
      setError("Couldn’t export the spreadsheet. Try again.");
    }
  }

  return (
    <>
      <Screen role="Admin" className={`admin-screen admin-${active}`}>
        <div className="screen-content">
          {data.event && (
            <EventPicker event={data.event} events={data.events} onCreate={() => setPanel({ type: "event" })} />
          )}
          <ScreenTitle>{TABS[active][0]}</ScreenTitle>
          {active === "guests" && (
            <>
              <div className="admin-search">
                <input className="text-field" type="search" aria-label="Search guests" placeholder="Search guests"
                  value={query} onChange={(event) => setQuery(event.target.value)} />
                <button className="button button-secondary" onClick={() => setPanel({ type: "import" })}>Import</button>
              </div>
              <ul className="admin-list">
                {guests.map((guest) => (
                  <li key={guest.id}>
                    {guest.fullName} · {guest.role === "manager" ? "Manager" : `${guest.remaining} left`}
                  </li>
                ))}
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
              {!data.drinks.length && <li>Add a drink to set its starting stock.</li>}
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
              {report ? report.map(({ role, title, total, detailRows }) => (
                <section className="card-orders" key={role} aria-label={title}>
                  <h2>{title}</h2>
                  <p>{total} {total === 1 ? "drink" : "drinks"}</p>
                  <ul className="admin-list order-list">
                    {detailRows.map(([name, staffId, bartenderName, orderDate, time], index) => (
                      <li key={index}>
                        <div>{name}{staffId && ` · ${staffId}`}</div>
                        <div>{bartenderName} · {orderDate} · {time}</div>
                      </li>
                    ))}
                  </ul>
                </section>
              )) : <ul className="admin-list order-list">
                {orders.map((order) => (
                  <li key={order.id}>
                    <div>{order.drink} · {formatTime(order.scannedAt)}</div>
                    <div>{order.guest.fullName}{order.guest.identifier && ` · ${order.guest.identifier}`}</div>
                  </li>
                ))}
              </ul>}
              {!orders.length && <p className="screen-description">No served drinks match these filters.</p>}
            </>
          )}
          {notice && <p className="screen-description" role="status">{notice}</p>}
          {error && <p className="field-error" role="alert">{error}</p>}
        </div>
        <div className="screen-actions navigation-actions">
          {active === "orders" && (
            <div className="export-actions">
              <button className="button button-primary" onClick={() => window.print()}>Export PDF</button>
              <button className="button button-secondary" onClick={exportSpreadsheet}>Export spreadsheet</button>
            </div>
          )}
          <BottomNav label="Admin sections" tabs={cardEvent ? CARD_NAV_TABS : ADMIN_NAV_TABS} active={active}
            onSelect={(id) => { setActive(id); setNotice(""); setError(""); }}
            add={active === "orders" ? undefined : {
              label: active === "guests" ? "Add guest" : "Add drink",
              onClick: () => setPanel({ type: active === "guests" ? "add-guest" : "add-stock" }),
            }} />
        </div>
      </Screen>
      {active === "orders" && (
        <section className="print-orders">
          <h1>Drink Pass · Served drinks</h1>
          {data.event && <p>{data.event.name} · {data.event.date}</p>}
          <p>{date === "today" ? today : date === "all" ? "All dates" : date} · {bartender === "all" ? "All bartenders" : bartender}</p>
          {report ? report.map(({ role, title, total, countRows, detailRows }) => (
            <section className="card-orders" key={role}>
              <h2>{title}</h2>
              <p>Total drinks {total}</p>
              <ReportTable columns={COUNT_COLUMNS} rows={countRows} />
              <ReportTable columns={DETAIL_COLUMNS} rows={detailRows} />
            </section>
          )) : <ReportTable columns={ORDER_COLUMNS} rows={orderRows} />}
        </section>
      )}
      {panel?.type === "event" && <EventDialog close={() => setPanel(null)} />}
      {panel && panel.type !== "event" && (panel.type === "edit-stock" || panel.type === "add-stock"
        ? <StockDialog action={panel.drink ? "update" : "add"} drink={panel.drink}
            notify={setNotice} close={() => setPanel(null)} />
        : <AdminDialog panel={panel} notify={setNotice} close={() => setPanel(null)}
            defaultVouchers={data.event?.defaultVouchers ?? INITIAL_VOUCHERS} cardEvent={cardEvent} />)}
    </>
  );
}

function ReportTable({ columns, rows }) {
  return (
    <table>
      <thead><tr>{columns.map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
      <tbody>{rows.map((row, index) => (
        <tr key={index}>{row.map((cell, column) => <td key={columns[column]}>{cell}</td>)}</tr>
      ))}</tbody>
    </table>
  );
}
