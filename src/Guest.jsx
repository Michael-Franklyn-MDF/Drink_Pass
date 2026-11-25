import { useEffect, useState } from "react";
import QRCode from "qrcode";
import {
  cancelVoucher, formatTime, IDENTIFIER_TYPES, INITIAL_VOUCHERS, managerInvitation,
  openVoucher, QR_PREFIX, registerGuest, scanVoucher, useEvent, VOUCHER_DURATION,
} from "./eventStore.js";
import { Dialog, isDemoMode, Screen, ScreenTitle } from "./ui.jsx";

const EMPTY_PROFILE = { fullName: "", identifier: "", department: "" };
const FIELD_LABELS = { fullName: "Full name", department: "Department" };

function Registration({ manager, onRegister }) {
  const [profile, setProfile] = useState(manager ? managerInvitation : EMPTY_PROFILE);
  const [identifierType, setIdentifierType] = useState("Staff ID");
  const [validated, setValidated] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  function field(name) {
    const label = FIELD_LABELS[name] ?? identifierType;
    const invalid = validated && !profile[name].trim();

    return (
      <div className={`profile-field profile-${name}`} key={name}>
        <label className={name === "identifier" ? "sr-only" : "field-label"} htmlFor={name}>{label}</label>
        <input
          className="text-field" id={name} name={name} value={profile[name]} readOnly={manager}
          placeholder={`Enter your ${label.toLowerCase().replace(/id$/, "ID")}`}
          onChange={(event) => setProfile({ ...profile, [name]: event.target.value })}
          autoComplete={name === "fullName" ? "name" : name === "identifier" && identifierType === "Phone number" ? "tel" : "off"}
          inputMode={name === "identifier" && identifierType === "Phone number" ? "tel" : undefined}
          aria-invalid={invalid} aria-describedby={invalid ? `${name}-error` : undefined} required
        />
        {invalid && <p className="field-error" id={`${name}-error`}>{label} is required.</p>}
      </div>
    );
  }

  async function submit(event) {
    event.preventDefault();
    const missing = Object.keys(EMPTY_PROFILE).find((name) => !profile[name].trim());
    setValidated(true);
    if (missing) {
      event.currentTarget.elements.namedItem(missing).focus();
      return;
    }

    setSaving(true);
    setError("");
    try {
      await onRegister({
        fullName: profile.fullName.trim(), identifier: profile.identifier.trim(),
        department: profile.department.trim(), identifierType, role: manager ? "manager" : "staff",
      });
    } catch {
      setError("Couldn’t save your details. Try again.");
      setSaving(false);
    }
  }

  return (
    <>
      <div className="screen-content">
        <ScreenTitle description={manager ? "Pre-filled from your manager QR." : "Register once for this event."}>
          Your details
        </ScreenTitle>
        <form id="registration" className="registration-form" onSubmit={submit} noValidate>
          {field("fullName")}
          {!manager && (
            <>
              <p className="field-label identifier-label" id="identifier-label">Identify yourself with</p>
              <div className="segmented-control" role="group" aria-labelledby="identifier-label">
                {IDENTIFIER_TYPES.map((type) => (
                  <button key={type} type="button" aria-pressed={type === identifierType}
                    onClick={() => setIdentifierType(type)}>{type}</button>
                ))}
              </div>
              {field("identifier")}
            </>
          )}
          {field("department")}
          {manager && (
            <>
              <p className="manager-chip"><span aria-hidden="true">✓</span> Registered as Manager</p>
              <p className="screen-description manager-role-note">Your role comes from the QR and can't be changed.</p>
            </>
          )}
        </form>
        {error && <p className="field-error" role="alert">{error}</p>}
      </div>
      <div className="screen-actions">
        <button className="button button-primary" type="submit" form="registration" disabled={saving}>Continue</button>
      </div>
    </>
  );
}

function remainingText(remaining) {
  return `${remaining} ${remaining === 1 ? "drink" : "drinks"} left`;
}

function VoucherQr({ id }) {
  const [image, setImage] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(QR_PREFIX + id, { width: 400, margin: 4 }).then(
      (url) => { if (!cancelled) setImage(url); },
      () => { if (!cancelled) setFailed(true); },
    );
    return () => { cancelled = true; };
  }, [id]);

  return (
    <div className="voucher-qr">
      {image ? <img src={image} alt="Voucher QR code" width="246" height="246" /> :
        <p role="status">{failed ? "Couldn’t create QR code." : "Preparing QR code…"}</p>}
    </div>
  );
}

function useRemainingSeconds(expiresAt) {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => setNow(Date.now());
    tick();
    const interval = window.setInterval(tick, 250);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [expiresAt]);

  return Math.min(VOUCHER_DURATION, Math.max(0, Math.ceil((expiresAt - now) / 1000)));
}

function VoucherSheet({ voucher, drink, manager, dismiss }) {
  const seconds = useRemainingSeconds(voucher.expiresAt);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const order = voucher.order;
  const state = order ? "receipt" : voucher.status === "expired" || seconds === 0 ? "expired" : "live";

  async function simulate(action) {
    try {
      if (action === "expired") {
        await cancelVoucher(voucher.id, "expired");
      } else {
        const result = await scanVoucher(QR_PREFIX + voucher.id);
        if (result.status !== "accepted") setError("Couldn’t redeem this voucher. Try again.");
      }
    } catch {
      setError("Couldn’t update this voucher. Try again.");
    }
  }

  async function copyDemoCode() {
    try {
      await navigator.clipboard.writeText(QR_PREFIX + voucher.id);
      setCopied(true);
      setError("");
    } catch {
      setError("Couldn’t copy the code. Check clipboard access and try again.");
    }
  }

  async function close() {
    try {
      await dismiss();
    } catch {
      setError("Couldn’t cancel this voucher. Try again.");
    }
  }

  const announcement = Math.ceil(seconds / 30) * 30;
  return (
    <Dialog key={state} titleId="voucher-title" onClose={close} className={`bottom-sheet ${state}-sheet`}>
      <div className="sheet-handle" aria-hidden="true" />
      {state === "live" && (
        <>
          <h2 id="voucher-title">Show this at the bar</h2>
          <p className="screen-description">{drink?.name}</p>
          <VoucherQr id={voucher.id} />
          <p className="expiry-countdown" aria-hidden="true">
            {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")} left
          </p>
          <span className="sr-only" role="status">{announcement} seconds left</span>
          <div className="sheet-actions">
            {isDemoMode() && (
              <div className="demo-actions">
                <button type="button" onClick={() => simulate("redeem")}>Simulate successful scan</button>
                <button type="button" onClick={() => simulate("expired")}>Simulate expiry</button>
                <button type="button" onClick={copyDemoCode}>{copied ? "Demo code copied" : "Copy demo code"}</button>
              </div>
            )}
            <button className="button button-secondary" onClick={close}>Cancel voucher</button>
          </div>
        </>
      )}
      {state === "receipt" && (
        <>
          <div className="success-mark">
            <img src={`/assets/receipt-${manager ? "manager" : "staff"}.svg`} alt="" />
          </div>
          <h2 id="voucher-title" aria-live="polite">Voucher redeemed</h2>
          <p className="screen-description">{order.drink} · {formatTime(order.scannedAt)}</p>
          {!manager && <p className="receipt-balance">{remainingText(order.remaining)}</p>}
          <div className="sheet-actions">
            <button className="button button-primary" onClick={close}>Done</button>
          </div>
        </>
      )}
      {state === "expired" && (
        <>
          <h2 id="voucher-title" aria-live="polite">Voucher expired</h2>
          <p className="screen-description">Your drink wasn’t deducted.</p>
          <div className="sheet-actions">
            <button className="button button-secondary" onClick={close}>Back to drinks</button>
          </div>
        </>
      )}
      {error && state === "live" && <p className="field-error" role="alert">{error}</p>}
    </Dialog>
  );
}

export default function Guest({ mode, role }) {
  const data = useEvent();
  const manager = mode === "manager";
  const guest = data.guests.find(({ id }) => id === data.sessions[mode]);
  const [registering, setRegistering] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [voucherId, setVoucherId] = useState(() => Object.values(data.vouchers).find((voucher) =>
    voucher.guestId === guest?.id && voucher.status === "open" && voucher.expiresAt > Date.now(),
  )?.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const voucher = data.vouchers[voucherId];
  const selection = data.drinks.find(({ id }) => id === selectedId) ??
    data.drinks.find(({ stock }) => stock > 0);
  const activeVoucher = voucher && voucher.status !== "cancelled";
  const empty = guest?.remaining === 0 && !activeVoucher;

  async function issueVoucher() {
    setBusy(true);
    setError("");
    try {
      const next = await openVoucher(guest.id, selection.id);
      if (next) setVoucherId(next.id);
      else setError("This drink is no longer available. Choose another drink.");
    } catch {
      setError("Couldn’t open your voucher. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function dismissVoucher() {
    if (voucher.status === "open" && voucher.expiresAt > Date.now()) {
      if (await cancelVoucher(voucherId) === "redeemed") return;
    }
    setVoucherId(null);
  }

  if (!guest && !registering) {
    return (
      <Screen role={role} className="welcome-screen">
        <div className="welcome-content">
          <img src={`/assets/brand-${mode}.svg`} alt="" width="64" height="64" />
          <ScreenTitle>Welcome</ScreenTitle>
          <p className="screen-description welcome-description">Choose a drink.<br />Show your pass at the bar.</p>
          {!manager && <div className="welcome-summary">{INITIAL_VOUCHERS} drink vouchers</div>}
        </div>
        <div className="screen-actions">
          <button className="button button-primary" onClick={() => setRegistering(true)}>Get started</button>
        </div>
      </Screen>
    );
  }

  if (!guest) return <Screen role={role}><Registration manager={manager} onRegister={registerGuest} /></Screen>;

  if (empty) {
    return (
      <Screen role={role} className="empty-screen">
        <div className="empty-content">
          <div className="empty-illustration" aria-hidden="true">
            <img className="empty-glass" src="/assets/empty-glass.svg" alt="" />
            <span className="success-mark"><img src="/assets/empty-check.svg" alt="" /></span>
          </div>
          <ScreenTitle>No drinks left</ScreenTitle>
          <p className="screen-description">
            {guest.allowance === 0 ? "You have no drink vouchers for this event." :
              guest.allowance === 1 ? "You’ve used your drink voucher." :
                `You’ve used all ${guest.allowance} of your drink vouchers.`}
          </p>
        </div>
      </Screen>
    );
  }

  return (
    <>
      <Screen role={role} className={manager ? "manager-menu" : "staff-menu"}>
        <div className="screen-content">
          <ScreenTitle description="Select one drink to get a voucher.">Choose a drink</ScreenTitle>
          {!manager && <p className="remaining-count">{remainingText(voucher?.order && activeVoucher ? voucher.order.remaining + 1 : guest.remaining)}</p>}
          <fieldset className="drink-list">
            <legend className="sr-only">Available drinks</legend>
            {data.drinks.map((drink) => (
              <label className="drink-option" key={drink.id}>
                <input type="radio" name="drink" value={drink.id} checked={drink.id === selection?.id}
                  onChange={() => { setSelectedId(drink.id); setError(""); }} disabled={drink.stock === 0} />
                <span>{drink.name}{drink.stock === 0 && <small> · Out of stock</small>}</span>
                <span className="radio-indicator" aria-hidden="true" />
              </label>
            ))}
          </fieldset>
          {error && <p className="field-error" role="alert">{error}</p>}
        </div>
        <div className="screen-actions">
          <button className="button button-primary" onClick={issueVoucher}
            disabled={busy || !selection || selection.stock === 0}>Continue</button>
        </div>
      </Screen>
      {activeVoucher && <VoucherSheet key={voucher.id} voucher={voucher}
        drink={data.drinks.find(({ id }) => id === voucher.drinkId)} manager={manager} dismiss={dismissVoucher} />}
    </>
  );
}
