import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  backendMode, canServeDrink, cancelVoucher, formatTime, IDENTIFIER_TYPES, INITIAL_VOUCHERS, managerInvitation,
  openVoucher, QR_PREFIX, registerGuest, scanVoucher, useEvent, VOUCHER_DURATION,
} from "./eventStore.js";
import { Dialog, isDemoMode, Screen, ScreenTitle } from "./ui.jsx";

const EMPTY_PROFILE = { fullName: "", identifier: "", department: "" };
const FIELD_LABELS = { fullName: "Full name", department: "Department" };

function Registration({ manager, onRegister, titleRef }) {
  const prefilled = manager && !backendMode;
  const [profile, setProfile] = useState(prefilled ? managerInvitation : EMPTY_PROFILE);
  const [identifierType, setIdentifierType] = useState("Staff ID");
  const [identifiers, setIdentifiers] = useState({});
  const [invite, setInvite] = useState("");
  const [validated, setValidated] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const details = prefilled ? profile : { ...profile, identifier: identifiers[identifierType] ?? "" };

  function field(name) {
    const label = FIELD_LABELS[name] ?? identifierType;
    const invalid = validated && !details[name].trim();

    return (
      <div className={`profile-field profile-${name}`} key={name}>
        <label className={name === "identifier" ? "sr-only" : "field-label"} htmlFor={name}>{label}</label>
        <input
          className="text-field" id={name} name={name} value={details[name]} readOnly={prefilled}
          placeholder={`Enter your ${label.toLowerCase().replace(/id$/, "ID")}`}
          onChange={(event) => {
            const { value } = event.target;
            if (name === "identifier") setIdentifiers({ ...identifiers, [identifierType]: value });
            else setProfile({ ...profile, [name]: value });
            setError("");
          }}
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
    if (saving) return;
    const missing = Object.keys(EMPTY_PROFILE).find((name) => !details[name].trim()) ||
      (backendMode && !invite.trim() ? "invite" : "");
    setValidated(true);
    if (missing) {
      event.currentTarget.elements.namedItem(missing).focus();
      return;
    }

    setSaving(true);
    setError("");
    try {
      await onRegister({
        fullName: details.fullName.trim(), identifier: details.identifier.trim(),
        department: details.department.trim(), identifierType, role: manager ? "manager" : "staff",
        ...(backendMode && { invite: invite.trim() }),
      });
    } catch (issue) {
      setError(backendMode ? issue.message : "Couldn’t save your details. Try again.");
      setSaving(false);
    }
  }

  return (
    <>
      <div className="screen-content">
        <ScreenTitle focusRef={titleRef} description={prefilled ? "Pre-filled from your manager QR." : "Register once for this event."}>
          Your details
        </ScreenTitle>
        <form id="registration" className="registration-form" onSubmit={submit} noValidate>
          {field("fullName")}
          {!prefilled && (
            <>
              <p className="field-label identifier-label" id="identifier-label">Identify yourself with</p>
              <div className="segmented-control" role="group" aria-labelledby="identifier-label">
                {IDENTIFIER_TYPES.map((type) => (
                  <button key={type} type="button" aria-pressed={type === identifierType}
                    onClick={() => { setIdentifierType(type); setError(""); }}>{type}</button>
                ))}
              </div>
              {field("identifier")}
            </>
          )}
          {field("department")}
          {backendMode && (
            <div className="profile-field">
              <label className="field-label" htmlFor="invite">Invitation code</label>
              <input className="text-field" id="invite" name="invite" autoComplete="off" required value={invite}
                aria-invalid={validated && !invite.trim()}
                onChange={(event) => { setInvite(event.target.value); setError(""); }} />
            </div>
          )}
          {prefilled && (
            <>
              <p className="manager-chip"><span aria-hidden="true">✓</span> Registered as Manager</p>
              <p className="screen-description manager-role-note">Your role comes from the QR and can't be changed.</p>
            </>
          )}
        </form>
        {error && <p className="field-error" role="alert">{error}</p>}
      </div>
      <div className="screen-actions">
        <button className="button button-primary" type="submit" form="registration" disabled={saving}>
          {saving ? "Saving details…" : "Continue"}
        </button>
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
  const [seconds, setSeconds] = useState(() => secondsUntil(expiresAt));

  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => setSeconds(secondsUntil(expiresAt));
    tick();
    const interval = window.setInterval(tick, 250);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [expiresAt]);

  return seconds;
}

function secondsUntil(expiresAt) {
  if (!expiresAt) return 0;
  return Math.min(VOUCHER_DURATION, Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
}

function VoucherSheet({ voucher, drink, manager, dismiss, renew, renewing, requestError }) {
  const seconds = useRemainingSeconds(voucher.status === "open" ? voucher.expiresAt : null);
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
    if (renewing) return;
    try {
      await dismiss();
    } catch {
      setError("Couldn’t cancel this voucher. Try again.");
    }
  }

  const announcement = Math.ceil(seconds / 30) * 30;
  return (
    <Dialog focusKey={state} titleId="voucher-title" onClose={close}
      className={`bottom-sheet voucher-sheet ${state}-sheet`}>
      <div className="sheet-handle" aria-hidden="true" />
      <div key={state} className="voucher-body">
        {state === "live" && (
          <>
            <h2 id="voucher-title" tabIndex={-1}>Show this at the bar</h2>
            <p className="screen-description">{drink?.name}</p>
            <VoucherQr id={voucher.id} />
            <div className={`voucher-timer${seconds <= 30 ? " voucher-timer-soon" : ""}`} aria-hidden="true">
              <p className="expiry-countdown">
                {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")} left
              </p>
              <div className="voucher-time-track" style={{ "--time-remaining": seconds / VOUCHER_DURATION }}><span /></div>
              <p className="voucher-timer-note">{seconds <= 30 ? "Expires soon" : "\u00a0"}</p>
            </div>
            <span className="sr-only" role="status">{announcement} seconds left</span>
            {!canServeDrink(drink) && <p className="field-error" role="status">This drink is currently unavailable.</p>}
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
            <h2 id="voucher-title" tabIndex={-1}>Voucher redeemed</h2>
            <p className="screen-description">{order.drink} · {formatTime(order.scannedAt)}</p>
            {!manager && <p className="receipt-balance">{remainingText(order.remaining)}</p>}
            <div className="sheet-actions">
              <button className="button button-primary" onClick={close}>Done</button>
            </div>
          </>
        )}
        {state === "expired" && (
          <>
            <h2 id="voucher-title" tabIndex={-1}>Voucher expired</h2>
            <p className="screen-description">Your drink wasn’t deducted.</p>
            {requestError && <p className="field-error" role="alert">{requestError}</p>}
            <div className="sheet-actions">
              {canServeDrink(drink) && (
                <button className="button button-primary" disabled={renewing} onClick={renew}>
                  {renewing ? "Getting your voucher…" : "Get a new voucher"}
                </button>
              )}
              <button className="button button-secondary" disabled={renewing} onClick={close}>Back to drinks</button>
            </div>
          </>
        )}
        {error && state === "live" && <p className="field-error" role="alert">{error}</p>}
      </div>
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
  const titleRef = useRef(null);
  const voucherButton = useRef(null);
  const voucher = data.vouchers[voucherId];
  const firstAvailable = data.drinks.find(canServeDrink);
  const selection = data.drinks.find(({ id }) => id === selectedId) ?? firstAvailable;
  const activeVoucher = Boolean(voucher && voucher.status !== "cancelled");
  const empty = guest?.remaining === 0 && !activeVoucher;
  const stage = guest ? (empty ? "empty" : "menu") : registering ? "registration" : "welcome";
  const previousStage = useRef(stage);
  const hadVoucher = useRef(activeVoucher);

  useEffect(() => {
    if (stage !== previousStage.current) {
      window.scrollTo(0, 0);
      titleRef.current?.focus({ preventScroll: true });
    } else if (hadVoucher.current && !activeVoucher) {
      const target = voucherButton.current?.disabled ? titleRef.current : voucherButton.current;
      target?.focus({ preventScroll: true });
    }
    previousStage.current = stage;
    hadVoucher.current = activeVoucher;
  }, [stage, activeVoucher]);

  async function issueVoucher(drinkId) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await openVoucher(guest.id, drinkId);
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
    setError("");
    setVoucherId(null);
  }

  if (!guest && !registering) {
    return (
      <Screen key="welcome" role={role} className="welcome-screen">
        <div className="welcome-content">
          <img src={`/assets/brand-${mode}.svg`} alt="" width="64" height="64" />
          <ScreenTitle>Welcome</ScreenTitle>
          <p className="screen-description welcome-description">Choose a drink.<br />Show your pass at the bar.</p>
          {!manager && !backendMode && <div className="welcome-summary">{INITIAL_VOUCHERS} drink vouchers</div>}
        </div>
        <div className="screen-actions">
          <button className="button button-primary" onClick={() => setRegistering(true)}>Get started</button>
        </div>
      </Screen>
    );
  }

  if (!guest) {
    return (
      <Screen key="registration" role={role} className="guest-stage">
        <Registration manager={manager} onRegister={registerGuest} titleRef={titleRef} />
      </Screen>
    );
  }

  if (empty) {
    return (
      <Screen key="empty" role={role} className="empty-screen guest-stage">
        <div className="empty-content">
          <div className="empty-illustration" aria-hidden="true">
            <img className="empty-glass" src="/assets/empty-glass.svg" alt="" />
            <span className="success-mark"><img src="/assets/empty-check.svg" alt="" /></span>
          </div>
          <ScreenTitle focusRef={titleRef}>No drinks left</ScreenTitle>
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
      <Screen role={role} className={`guest-stage ${manager ? "manager-menu" : "staff-menu"}`}>
        <div className="screen-content">
          <ScreenTitle focusRef={titleRef} description="Select one drink to get a voucher.">Choose a drink</ScreenTitle>
          {!manager && <p className="remaining-count">{remainingText(voucher?.order && activeVoucher ? voucher.order.remaining + 1 : guest.remaining)}</p>}
          <fieldset className="drink-list">
            <legend className="sr-only">Available drinks</legend>
            {data.drinks.map((drink) => (
              <label className="drink-option" key={drink.id}>
                <input type="radio" name="drink" value={drink.id} checked={drink.id === selection?.id}
                  onChange={() => { setSelectedId(drink.id); setError(""); }} disabled={!canServeDrink(drink)} />
                <span>{drink.name}{!canServeDrink(drink) && <small> · {drink.stock === 0 ? "Out of stock" : "Unavailable"}</small>}</span>
                <span className="radio-indicator" aria-hidden="true" />
              </label>
            ))}
          </fieldset>
          {!firstAvailable && (
            <p className="guest-menu-notice screen-description" role="status">
              All drinks are currently unavailable. Check back when the bar has restocked.
            </p>
          )}
          {firstAvailable && selection && !canServeDrink(selection) && !activeVoucher && (
            <p className="guest-menu-notice screen-description" role="status">
              {selection.name} is currently unavailable. Choose another drink.
            </p>
          )}
          {error && !activeVoucher && <p className="field-error" role="alert">{error}</p>}
        </div>
        <div className="screen-actions">
          <button className="button button-primary" ref={voucherButton} onClick={() => issueVoucher(selection.id)}
            disabled={busy || !canServeDrink(selection)}>{busy && !activeVoucher ? "Getting your voucher…" : "Continue"}</button>
        </div>
      </Screen>
      {activeVoucher && <VoucherSheet key={voucher.id} voucher={voucher}
        drink={data.drinks.find(({ id }) => id === voucher.drinkId)} manager={manager} dismiss={dismissVoucher}
        renew={() => issueVoucher(voucher.drinkId)} renewing={busy} requestError={error} />}
    </>
  );
}
