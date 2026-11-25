import { useState } from "react";
import { addDrink, restockDrink, setStock } from "./eventStore.js";
import { Dialog, TextField } from "./ui.jsx";

const TITLES = { add: "Add drink", restock: "Restock drink", update: "Update stock" };

export default function StockDialog({ action, drink, close, notify }) {
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const restocking = action === "restock";

  async function submit(event) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const name = String(values.get("name") ?? "").trim();
    const stock = Number(values.get("stock"));
    const minimum = restocking ? 1 : 0;
    if (!Number.isSafeInteger(stock) || stock < minimum) {
      setError(restocking ? "Enter at least one whole bottle." : "Enter a whole number of bottles.");
      return;
    }

    setError("");
    setSaving(true);
    try {
      if (action === "add") {
        if (!name) throw new Error("Enter a drink name.");
        if (!await addDrink(name, stock)) throw new Error("A drink with this name already exists.");
        notify("Drink added.");
      } else if (restocking) {
        await restockDrink(drink.id, stock);
        notify(`${drink.name} restocked.`);
      } else {
        await setStock(drink.id, stock);
        notify("Stock updated.");
      }
      close();
    } catch (issue) {
      setError(issue.message || "Couldn’t save your changes. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog titleId="stock-dialog-title" onClose={() => { if (!saving) close(); }} className="bottom-sheet">
      <div className="sheet-handle" aria-hidden="true" />
      <h2 id="stock-dialog-title">{TITLES[action]}</h2>
      <form className="admin-form" onSubmit={submit}>
        <TextField label="Drink name" name="name" defaultValue={drink?.name} readOnly={action !== "add"} />
        <TextField label={restocking ? "Bottles to add" : "Bottles in stock"} name="stock" type="number"
          min={restocking ? 1 : 0} step="1" defaultValue={restocking ? "" : drink?.stock ?? 0} />
        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="admin-form-actions">
          <button className="button button-primary" disabled={saving}>Save</button>
          <button className="button button-secondary" type="button" onClick={close} disabled={saving}>Cancel</button>
        </div>
      </form>
    </Dialog>
  );
}
