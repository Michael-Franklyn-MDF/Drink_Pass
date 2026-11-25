import { useEffect, useState } from "react";

const INITIAL_VOUCHERS = 5;
const VOUCHER_DURATION = 120;
const DRINKS = [
  "Ginger beer",
  "Sparkling water",
  "Passion juice",
  "Cola",
  "Lemonade",
  "Iced tea",
];
const IDENTIFIER_TYPES = ["Staff ID", "Phone number", "Personal ID"];

function getAppRole() {
  const queryRole = new URLSearchParams(window.location.search).get("role");
  const pathSegments = window.location.pathname.split("/").filter(Boolean);
  if (queryRole === "manager" || pathSegments.includes("manager")) return "manager";
  if (queryRole === "staff" || pathSegments.includes("staff")) return "staff";
  return import.meta.env.MODE === "manager" ? "manager" : "staff";
}

function BrandMark() {
  return (
    <div className="brand-mark grid size-16 place-items-center rounded-2xl bg-[#1d1d1f] text-white" aria-hidden="true">
      <svg viewBox="0 0 44 44" fill="none" className="size-11">
        <path
          d="M8 13h28l-2.2 5.2a4 4 0 0 0 0 3.1l2.2 5.2H8l2.2-5.2a4 4 0 0 0 0-3.1L8 13Z"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinejoin="round"
        />
        <path
          d="M17 18h10l-1.2 8h-7.6L17 18Z"
          stroke="currentColor"
          strokeWidth="2.3"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

function TopBar({ role }) {
  return (
    <header className="flex items-center justify-between text-base leading-6 font-bold">
      <span>Drink Pass</span>
      <span>{role}</span>
    </header>
  );
}

function Screen({ children, className = "", role }) {
  return (
    <section className={`screen screen-enter flex min-h-svh flex-col px-6 ${className}`}>
      <TopBar role={role} />
      {children}
    </section>
  );
}

function QrPlaceholder({ onSimulateScan }) {
  const moduleCount = 25;
  const quietZone = 2;
  const finders = [
    [0, 0],
    [0, 18],
    [18, 0],
  ];
  const cells = [];

  for (let row = 0; row < moduleCount; row += 1) {
    for (let column = 0; column < moduleCount; column += 1) {
      const finder = finders.find(
        ([top, left]) => row >= top && row < top + 7 && column >= left && column < left + 7,
      );

      if (finder) {
        const x = column - finder[1];
        const y = row - finder[0];
        if (x === 0 || x === 6 || y === 0 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4)) {
          cells.push(
            <rect
              key={`${row}-${column}`}
              x={column + quietZone}
              y={row + quietZone}
              width="1"
              height="1"
            />,
          );
        }
      } else if ((row * 17 + column * 13 + row * column * 3) % 11 < 5) {
        cells.push(
          <rect
            key={`${row}-${column}`}
            x={column + quietZone}
            y={row + quietZone}
            width="1"
            height="1"
          />,
        );
      }
    }
  }

  const size = moduleCount + quietZone * 2;
  const code = (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className="size-[84%]"
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      <rect width={size} height={size} fill="#fff" />
      <g fill="#000">{cells}</g>
    </svg>
  );

  if (onSimulateScan) {
    return (
      <button
        className="qr-placeholder grid aspect-square w-[min(248px,68vw)] shrink-0 place-items-center self-center rounded-[17px] border border-[#e2e2e8]"
        type="button"
        aria-label="Demo QR code placeholder. Activate to simulate a successful scan."
        onClick={onSimulateScan}
      >
        {code}
      </button>
    );
  }

  return (
    <div
      className="qr-placeholder grid aspect-square w-[min(248px,68vw)] shrink-0 place-items-center self-center rounded-[17px] border border-[#e2e2e8]"
      role="img"
      aria-label="Demo QR code placeholder. It cannot be scanned."
    >
      {code}
    </div>
  );
}

function formatTime(seconds) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function App() {
  const isManager = getAppRole() === "manager";
  const roleName = isManager ? "Manager" : "Staff";
  const menuDrinks = isManager ? DRINKS.slice(0, 3) : DRINKS;
  const [screen, setScreen] = useState("welcome");
  const [remaining, setRemaining] = useState(INITIAL_VOUCHERS);
  const [identifierType, setIdentifierType] = useState("Staff ID");
  const [registration, setRegistration] = useState({
    fullName: "",
    identifier: "",
    department: "",
  });
  const [selectedDrink, setSelectedDrink] = useState(DRINKS[0]);
  const [showValidation, setShowValidation] = useState(false);
  const [notice, setNotice] = useState("");
  const [voucherOpen, setVoucherOpen] = useState(false);
  const [voucherResult, setVoucherResult] = useState(null);
  const [secondsLeft, setSecondsLeft] = useState(VOUCHER_DURATION);
  const [receipt, setReceipt] = useState(null);
  const fieldErrors = {
    fullName: showValidation && !registration.fullName.trim() ? "Full name is required." : "",
    identifier: showValidation && !registration.identifier.trim() ? `${identifierType} is required.` : "",
    department: showValidation && !registration.department.trim() ? "Department is required." : "",
  };

  useEffect(() => {
    document.documentElement.classList.toggle("manager-theme-active", isManager);
    return () => document.documentElement.classList.remove("manager-theme-active");
  }, [isManager]);

  useEffect(() => {
    if (!voucherOpen) return undefined;

    const timerId = window.setInterval(() => {
      setSecondsLeft((seconds) => Math.max(seconds - 1, 0));
    }, 1000);

    return () => window.clearInterval(timerId);
  }, [voucherOpen]);

  useEffect(() => {
    if (voucherOpen && secondsLeft === 0) {
      setVoucherOpen(false);
      setVoucherResult("expired");
    }
  }, [voucherOpen, secondsLeft]);

  function updateRegistration(event) {
    const { name, value } = event.target;
    setRegistration((current) => ({ ...current, [name]: value }));
  }

  function continueRegistration(event) {
    event.preventDefault();
    const missingField = Object.entries(registration).find(([, value]) => !value.trim())?.[0];
    setShowValidation(true);

    if (missingField) {
      const fieldIds = {
        fullName: "full-name",
        identifier: "identifier",
        department: "department",
      };
      document.getElementById(fieldIds[missingField])?.focus();
      return;
    }

    setShowValidation(false);
    setNotice("");
    setScreen("menu");
  }

  function openVoucher() {
    if (remaining <= 0) {
      setScreen("empty");
      return;
    }

    setVoucherResult(null);
    setNotice("");
    setSecondsLeft(VOUCHER_DURATION);
    setVoucherOpen(true);
  }

  function cancelVoucher() {
    setVoucherOpen(false);
    setNotice("");
  }

  function expireVoucher() {
    setVoucherOpen(false);
    setVoucherResult("expired");
    setNotice("");
  }

  function simulateSuccessfulScan() {
    if (!voucherOpen || secondsLeft <= 0) return;

    const balanceAfterRedemption = remaining - 1;
    setRemaining(balanceAfterRedemption);
    setReceipt({
      drink: selectedDrink,
      remaining: balanceAfterRedemption,
      redeemedAt: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    });
    setVoucherOpen(false);
    setVoucherResult("receipt");
    setNotice("");
  }

  function continueFromReceipt() {
    setVoucherResult(null);
    if (remaining === 0) {
      setScreen("empty");
      return;
    }

    setNotice(`${receipt.drink} redeemed. Choose another drink when you’re ready.`);
    setScreen("menu");
  }

  function dismissVoucherSheet() {
    if (voucherOpen) {
      cancelVoucher();
    } else if (voucherResult === "receipt") {
      continueFromReceipt();
    } else {
      setVoucherResult(null);
    }
  }

  return (
    <main className={`app-shell relative mx-auto min-h-svh w-full max-w-[430px] overflow-hidden border-x-2 border-[#f1f1f4] bg-white text-[#1d1d1f] ${isManager ? "manager-theme" : ""}`}>
      {screen === "welcome" && (
        <Screen className="welcome-screen" role={roleName}>
          <div className="welcome-content mt-[37px]">
            <BrandMark />
            <h1 className="mt-[5px] text-4xl leading-[1.15] font-bold tracking-[-1.35px]">Welcome</h1>
            <p className="mt-6 text-[15px] leading-[23px] text-[#65656b]">
              Choose a drink.
              <br />
              Show your pass at the bar.
            </p>
            {!isManager && (
              <div className="welcome-summary mt-8 rounded-2xl bg-[#f1f1f5] px-[18px] py-[17px] text-xl leading-7 font-bold">
                {remaining} drink {remaining === 1 ? "voucher" : "vouchers"}
              </div>
            )}
          </div>
          <button className="button button-primary mt-auto" onClick={() => setScreen("registration")}>
            Get started
          </button>
        </Screen>
      )}

      {screen === "registration" && (
        <Screen className={`registration-screen ${isManager ? "manager-registration" : ""}`} role={roleName}>
          <div className="registration-content mt-[29px]">
            <h1 className="text-4xl leading-[1.15] font-bold tracking-[-1.35px]">Your details</h1>
            <p className="mt-1 text-[15px] leading-[23px] text-[#65656b]">Register once for this event.</p>
            <form className="mt-8 flex flex-col" onSubmit={continueRegistration} noValidate>
              <label className={`field-label ${fieldErrors.fullName ? "field-label-error" : ""}`} htmlFor="full-name">
                Full name
              </label>
              <input
                className="text-field"
                id="full-name"
                name="fullName"
                aria-invalid={Boolean(fieldErrors.fullName)}
                aria-describedby={fieldErrors.fullName ? "full-name-error" : undefined}
                autoComplete="name"
                placeholder="Enter your full name"
                value={registration.fullName}
                onChange={updateRegistration}
                required
              />
              {fieldErrors.fullName && <p className="field-error" id="full-name-error">{fieldErrors.fullName}</p>}

              {isManager ? (
                <label
                  className={`field-label manager-staff-label ${fieldErrors.identifier ? "field-label-error" : ""}`}
                  htmlFor="identifier"
                >
                  Staff ID
                </label>
              ) : (
                <>
                  <span className="field-label identifier-label" id="identifier-label">
                    Identify yourself with
                  </span>
                  <div className="segmented-control flex min-h-12" role="group" aria-labelledby="identifier-label">
                    {IDENTIFIER_TYPES.map((type) => (
                      <button
                        className={`segment min-w-0 flex-1 rounded-[10px] px-2 text-[13px] whitespace-nowrap ${
                          identifierType === type ? "segment-active" : ""
                        }`}
                        key={type}
                        type="button"
                        aria-pressed={identifierType === type}
                        onClick={() => setIdentifierType(type)}
                      >
                        {type}
                      </button>
                    ))}
                  </div>
                  <label className="sr-only" htmlFor="identifier">
                    {identifierType}
                  </label>
                </>
              )}
              <input
                className="text-field identifier-field"
                id="identifier"
                name="identifier"
                autoComplete={identifierType === "Phone number" ? "tel" : "off"}
                inputMode={identifierType === "Phone number" ? "tel" : "text"}
                aria-invalid={Boolean(fieldErrors.identifier)}
                aria-describedby={fieldErrors.identifier ? "identifier-error" : undefined}
                placeholder={`Enter your ${identifierType.toLowerCase()}`}
                value={registration.identifier}
                onChange={updateRegistration}
                required
              />
              {fieldErrors.identifier && <p className="field-error" id="identifier-error">{fieldErrors.identifier}</p>}

              <label className={`field-label department-label ${isManager ? "manager-department-label" : ""} ${fieldErrors.department ? "field-label-error" : ""}`} htmlFor="department">
                Department
              </label>
              <input
                className="text-field"
                id="department"
                name="department"
                aria-invalid={Boolean(fieldErrors.department)}
                aria-describedby={fieldErrors.department ? "department-error" : undefined}
                autoComplete="organization-title"
                placeholder="Enter your department"
                value={registration.department}
                onChange={updateRegistration}
                required
              />
              {fieldErrors.department && <p className="field-error" id="department-error">{fieldErrors.department}</p>}
            </form>
          </div>
          <button className="button button-primary mt-auto" onClick={continueRegistration}>
            Continue
          </button>
        </Screen>
      )}

      {screen === "menu" && (
        <Screen className="menu-screen" role={roleName}>
          <div className={`menu-content mt-[29px] ${isManager ? "manager-menu-content" : ""}`}>
            <h1 className="text-4xl leading-[1.15] font-bold tracking-[-1.35px]">Choose a drink</h1>
            <p className="mt-1 text-[15px] leading-[23px] text-[#65656b]">Select one drink to get a voucher.</p>
            {!isManager && (
              <div className="remaining-count mt-[22px] inline-flex min-h-[34px] min-w-[119px] items-center rounded-full bg-[#f1f1f5] px-[14px] text-sm font-bold">
                {remaining} {remaining === 1 ? "drink" : "drinks"} left
              </div>
            )}
            {notice && <p className="status-message mt-3 text-[13px] leading-[19px] text-[#65656b]" role="status">{notice}</p>}

            <div className="drink-list mt-[25px] grid gap-3" role="group" aria-label="Available drinks">
              {menuDrinks.map((drink) => {
                const selected = selectedDrink === drink;
                return (
                  <button
                    className={`drink-option flex min-h-[60px] items-center justify-between rounded-[14px] border px-4 text-left text-base font-bold ${
                      selected ? "drink-option-selected" : "border-[#e2e2e8] bg-white"
                    }`}
                    key={drink}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      setSelectedDrink(drink);
                      setNotice("");
                    }}
                  >
                    <span>{drink}</span>
                    <span className={`radio-indicator grid size-5 place-items-center rounded-full ${selected ? "radio-selected" : ""}`} aria-hidden="true" />
                  </button>
                );
              })}
            </div>
          </div>
          <button className="button button-primary mt-auto" onClick={openVoucher}>
            Continue
          </button>
        </Screen>
      )}

      {screen === "empty" && (
        <Screen className="empty-screen" role={roleName}>
          <div className="empty-content my-auto flex flex-col items-center pb-[110px] text-center">
            <div className="empty-drink-icon relative grid h-[96px] w-[100px] place-items-center" aria-hidden="true">
              <svg viewBox="0 0 76 90" className="h-[90px] w-[76px]" fill="none">
                <path d="M8 8h60l-8 76H16L8 8Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
                <path d="M15 34h46" stroke="currentColor" strokeWidth="2" />
              </svg>
              <span className="absolute right-0 bottom-1 grid size-11 place-items-center rounded-full bg-[#f1f1f5]">
                <svg viewBox="0 0 24 24" className="size-7" fill="none">
                  <path d="m5 12 4.5 4.5L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            </div>
            <h1 className="mt-[35px] text-[36px] leading-[43px] font-bold tracking-[-1.2px]">No drinks left</h1>
            <p className="mt-3 text-[15px] leading-[23px] text-[#65656b]">
              You’ve used all {INITIAL_VOUCHERS} of your drink vouchers.
            </p>
          </div>
        </Screen>
      )}

      {(voucherOpen || voucherResult) && (
        <div className="voucher-overlay fixed inset-0 z-10 mx-auto w-full max-w-[430px]" role="presentation">
          <button
            className="overlay-backdrop absolute inset-0 size-full cursor-pointer border-0 bg-black/40"
            type="button"
            aria-label="Close voucher details"
            onClick={dismissVoucherSheet}
          />
          {voucherOpen && (
            <section
              className="voucher-sheet absolute inset-x-0 bottom-0 flex min-h-[70svh] flex-col rounded-t-3xl bg-white px-[22px] pt-3 pb-[calc(51px+env(safe-area-inset-bottom))]"
              role="dialog"
              aria-modal="true"
              aria-labelledby="voucher-title"
              aria-describedby="voucher-description"
            >
              <div className="sheet-handle mb-[11px] h-1 w-[46px] shrink-0 self-center rounded-full bg-[#e5e5ea]" aria-hidden="true" />
              <h2 className="text-[27px] leading-[33px] font-bold tracking-[-0.75px]" id="voucher-title">
                Show this at the bar
              </h2>
              <p className="mt-1 text-[15px] leading-[22px] text-[#65656b]" id="voucher-description">
                {selectedDrink}
              </p>
              <QrPlaceholder onSimulateScan={isManager ? simulateSuccessfulScan : undefined} />
              <p className="expiry-countdown mt-[29px] text-center text-2xl leading-[31px] font-bold" aria-live="polite">
                {formatTime(secondsLeft)} left
              </p>
              <div className="sheet-actions mt-auto grid gap-1.5 pt-3">
                {isManager ? (
                  <button className="button button-tertiary justify-center text-center" onClick={cancelVoucher}>
                    Cancel voucher
                  </button>
                ) : (
                  <>
                    <button className="button button-primary justify-center text-center" onClick={simulateSuccessfulScan}>
                      Simulate successful scan
                    </button>
                    <button className="button button-tertiary justify-center text-center" onClick={cancelVoucher}>
                      Cancel voucher
                    </button>
                    <button className="text-action min-h-[30px] text-[13px] text-[#65656b]" onClick={expireVoucher}>
                      Simulate expiry
                    </button>
                  </>
                )}
              </div>
            </section>
          )}
          {voucherResult === "receipt" && receipt && (
            <section
              className="result-sheet receipt-sheet absolute inset-x-0 bottom-0 flex min-h-[43svh] flex-col rounded-t-3xl bg-white px-[22px] pt-3 pb-[calc(51px+env(safe-area-inset-bottom))]"
              role="dialog"
              aria-modal="true"
              aria-labelledby="receipt-title"
            >
              <div className="sheet-handle mb-4 h-1 w-[46px] shrink-0 self-center rounded-full bg-[#e5e5ea]" aria-hidden="true" />
              <div className="success-mark grid size-11 place-items-center rounded-full bg-[#f1f1f5]" aria-hidden="true">
                <svg viewBox="0 0 24 24" className="size-7" fill="none">
                  <path className="success-mark-path" d="m5 12 4.5 4.5L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <h2 className="mt-[10px] text-[30px] leading-[36px] font-bold tracking-[-0.8px]" id="receipt-title">
                Voucher redeemed
              </h2>
              <p className="mt-2 text-[15px] leading-[22px] text-[#65656b]">
                {receipt.drink} · {receipt.redeemedAt}
              </p>
              {!isManager && (
                <p className="mt-[22px] text-base leading-6 font-bold" aria-live="polite">
                  {receipt.remaining} {receipt.remaining === 1 ? "drink" : "drinks"} left
                </p>
              )}
              <button className="button button-primary mt-auto" onClick={continueFromReceipt}>
                Done
              </button>
            </section>
          )}
          {voucherResult === "expired" && (
            <section
              className="result-sheet expired-sheet absolute inset-x-0 bottom-0 flex min-h-[34svh] flex-col rounded-t-3xl bg-white px-[23px] pt-3 pb-[calc(51px+env(safe-area-inset-bottom))]"
              role="dialog"
              aria-modal="true"
              aria-labelledby="expired-title"
            >
              <div className="sheet-handle mb-5 h-1 w-[46px] shrink-0 self-center rounded-full bg-[#e5e5ea]" aria-hidden="true" />
              <h2 className="text-[30px] leading-[36px] font-bold tracking-[-0.8px]" id="expired-title">
                Voucher expired
              </h2>
              <p className="mt-2 text-[15px] leading-[22px] text-[#65656b]">Your drink wasn’t deducted.</p>
              <button className="button button-tertiary mt-auto" onClick={() => setVoucherResult(null)}>
                Back to drinks
              </button>
            </section>
          )}
        </div>
      )}

      <div className="home-indicator pointer-events-none fixed inset-x-0 bottom-[max(15px,env(safe-area-inset-bottom))] z-20 mx-auto flex w-[min(calc(100%-32px),430px)] justify-center" aria-hidden="true">
        <span className="h-[5px] w-[134px] rounded-full bg-[#171719]" />
      </div>
    </main>
  );
}

export default App;
