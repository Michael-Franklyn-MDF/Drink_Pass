import { useState } from "react";
import { canServeDrink, setDrinkEnabled, useEvent } from "./eventStore.js";
import StockDialog from "./StockDialog.jsx";
import { Screen, ScreenTitle } from "./ui.jsx";

export default function BartenderDrinks({ onBack, backLabel }) {
  const { drinks } = useEvent();
  const [panel, setPanel] = useState(null);
  const [pending, setPending] = useState(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function toggleDrink(drink) {
    const enable = Boolean(drink.paused);
    setPending(drink.id);
    setNotice("");
    setError("");
    try {
      await setDrinkEnabled(drink.id, enable);
      setNotice(`${drink.name} ${enable ? "enabled" : "disabled"}.`);
    } catch (issue) {
      setError(issue.message || "Couldn’t update availability. Try again.");
    } finally {
      setPending(null);
    }
  }

  return (
    <>
      <Screen role="Bartender" className="bartender-drinks">
        <div className="screen-content">
          <ScreenTitle description="Update stock and availability on the guest menu.">Drinks and stock</ScreenTitle>
          <ul className="bartender-drink-list">
            {drinks.map((drink) => {
              const soldOut = drink.stock <= 0;
              const status = soldOut ? "Out of stock" : canServeDrink(drink) ? "Available" : "Disabled";
              const action = drink.paused ? "Enable" : "Disable";

              return (
                <li key={drink.id} aria-label={drink.name}>
                  <h2>{drink.name}</h2>
                  <p>{drink.stock} {drink.stock === 1 ? "bottle" : "bottles"} · {status}</p>
                  <div className="bartender-drink-actions">
                    <button className="button button-secondary" type="button" aria-label={`Restock ${drink.name}`}
                      onClick={() => setPanel({ action: "restock", drink })}>Restock</button>
                    <button className="button button-secondary" type="button" aria-label={`Edit stock for ${drink.name}`}
                      onClick={() => setPanel({ action: "update", drink })}>Edit stock</button>
                    <button className="button button-secondary" type="button" aria-label={`${action} ${drink.name}`}
                      disabled={soldOut || pending === drink.id} onClick={() => toggleDrink(drink)}>{action}</button>
                  </div>
                </li>
              );
            })}
          </ul>
          {notice && <p className="screen-description" role="status">{notice}</p>}
          {error && <p className="field-error" role="alert">{error}</p>}
        </div>
        <div className="screen-actions bartender-actions">
          <button className="button button-secondary" type="button" onClick={onBack}>{backLabel}</button>
          <button className="button button-primary" type="button" onClick={() => setPanel({ action: "add" })}>Add drink</button>
        </div>
      </Screen>
      {panel && (
        <StockDialog action={panel.action} drink={panel.drink} close={() => setPanel(null)}
          notify={(message) => { setNotice(message); setError(""); }} />
      )}
    </>
  );
}
