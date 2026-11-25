import { useSyncExternalStore } from "react";

export const INITIAL_VOUCHERS = 5;
export const VOUCHER_DURATION = 120;
export const IDENTIFIER_TYPES = ["Staff ID", "Phone number", "Personal ID"];
export const DEMO_BARTENDER = "Bar 1";
export const QR_PREFIX = "drink-pass:";
const STORAGE_KEY = "drink-pass-event-v1";
const SAME_TAB_EVENT = "drink-pass-change";

export const managerInvitation = {
  fullName: "Sam Kato", identifier: "MGR-001", identifierType: "Staff ID",
  department: "Operations", role: "manager",
};

const sampleTime = new Date().setHours(19, 42, 0, 0);
const alex = {
  id: "alex", fullName: "Alex Kamau", identifier: "STF-042", identifierType: "Staff ID",
  department: "Operations", role: "staff", remaining: 2, allowance: INITIAL_VOUCHERS,
};

const initialState = {
  guests: [
    alex,
    { ...managerInvitation, id: "manager", remaining: null, allowance: null },
    {
      id: "ari", fullName: "Ari Mugo", identifier: "STF-043", identifierType: "Staff ID",
      department: "Operations", role: "staff", remaining: INITIAL_VOUCHERS, allowance: INITIAL_VOUCHERS,
    },
  ],
  drinks: [
    { id: "ginger-beer", name: "Ginger beer", stock: 24 },
    { id: "sparkling-water", name: "Sparkling water", stock: 18 },
    { id: "passion-juice", name: "Passion juice", stock: 18 },
  ],
  vouchers: {},
  orders: [{
    id: "sample-order", guest: alex, drink: "Ginger beer", scannedAt: sampleTime,
    remaining: alex.remaining, bartender: DEMO_BARTENDER,
  }],
  sessions: {},
};

function readRawState() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

let cachedRaw;
let cachedState = initialState;

function getSnapshot() {
  const raw = readRawState();
  if (cachedRaw !== raw) {
    cachedRaw = raw;
    try {
      cachedState = raw ? JSON.parse(raw) : initialState;
    } catch {
      cachedState = initialState;
    }
  }
  return cachedState;
}

function subscribe(listener) {
  function onStorage(event) {
    if (event.key === STORAGE_KEY || event.key === null) listener();
  }
  window.addEventListener("storage", onStorage);
  window.addEventListener(SAME_TAB_EVENT, listener);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(SAME_TAB_EVENT, listener);
  };
}

export function useEvent() {
  return useSyncExternalStore(subscribe, getSnapshot);
}

function update(mutator) {
  function commit() {
    const next = structuredClone(getSnapshot());
    const result = mutator(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event(SAME_TAB_EVENT));
    return result;
  }
  return navigator.locks ? navigator.locks.request(STORAGE_KEY, commit) : Promise.resolve().then(commit);
}

function addGuestToState(data, profile, remaining = INITIAL_VOUCHERS) {
  const existing = data.guests.find((guest) =>
    guest.role === profile.role &&
    guest.identifierType === profile.identifierType &&
    guest.identifier.toLowerCase() === profile.identifier.toLowerCase(),
  );
  if (existing) return { guest: existing, added: false };

  const balance = profile.role === "manager" ? null : remaining;
  const guest = { ...profile, id: crypto.randomUUID(), remaining: balance, allowance: balance };
  data.guests.push(guest);
  return { guest, added: true };
}

export function registerGuest(profile) {
  return update((data) => {
    const { guest } = addGuestToState(data, profile);
    data.sessions[profile.role] = guest.id;
    return guest;
  });
}

export function addGuests(profiles) {
  return update((data) => profiles.reduce((count, profile) =>
    count + Number(addGuestToState(data, profile, profile.remaining).added), 0));
}

export function addDrink(name, stock) {
  return update((data) => {
    if (data.drinks.some((drink) => drink.name.toLowerCase() === name.toLowerCase())) return false;
    data.drinks.push({ id: crypto.randomUUID(), name, stock });
    return true;
  });
}

export function setStock(drinkId, stock) {
  return update((data) => {
    const drink = data.drinks.find(({ id }) => id === drinkId);
    if (drink) drink.stock = stock;
  });
}

export function canServeDrink(drink) {
  return Boolean(drink && drink.stock > 0 && !drink.paused);
}

export function restockDrink(drinkId, bottles) {
  return update((data) => {
    const drink = data.drinks.find(({ id }) => id === drinkId);
    if (!drink) throw new Error("This drink is no longer listed.");
    const nextStock = drink.stock + bottles;
    if (!Number.isSafeInteger(nextStock)) throw new Error("Enter a smaller number of bottles.");
    drink.stock = nextStock;
  });
}

export function setDrinkEnabled(drinkId, enabled) {
  return update((data) => {
    const drink = data.drinks.find(({ id }) => id === drinkId);
    if (!drink) throw new Error("This drink is no longer listed.");
    if (enabled && drink.stock <= 0) throw new Error("Restock this drink before enabling it.");
    drink.paused = !enabled;
  });
}

export function openVoucher(guestId, drinkId) {
  return update((data) => {
    const now = Date.now();
    const guest = data.guests.find(({ id }) => guestId === id);
    const drink = data.drinks.find(({ id }) => drinkId === id);
    if (!guest || !canServeDrink(drink) || guest.remaining === 0) return null;

    const active = Object.values(data.vouchers).find((voucher) =>
      voucher.guestId === guestId && voucher.status === "open" && voucher.expiresAt > now,
    );
    if (active && active.drinkId === drinkId) return active;
    if (active) active.status = "cancelled";

    const voucher = {
      id: crypto.randomUUID(), guestId, drinkId, status: "open", expiresAt: now + VOUCHER_DURATION * 1000,
    };
    data.vouchers[voucher.id] = voucher;
    return voucher;
  });
}

export function cancelVoucher(id, status = "cancelled") {
  return update((data) => {
    const voucher = data.vouchers[id];
    if (voucher?.status === "open") voucher.status = status;
    return voucher?.status;
  });
}

export function scanVoucher(code, bartender = DEMO_BARTENDER, online = navigator.onLine) {
  if (!online) return Promise.resolve({ status: "offline" });
  if (!code.startsWith(QR_PREFIX)) return Promise.resolve({ status: "invalid" });

  return update((data) => {
    if (!navigator.onLine) return { status: "offline" };
    const id = code.slice(QR_PREFIX.length);
    const voucher = Object.hasOwn(data.vouchers, id) ? data.vouchers[id] : undefined;
    if (!voucher || voucher.status === "cancelled") return { status: "invalid" };
    if (voucher.status === "redeemed") return { status: "used", order: voucher.order };

    const scannedAt = Date.now();
    if (voucher.status === "expired" || voucher.expiresAt <= scannedAt) {
      voucher.status = "expired";
      return { status: "expired" };
    }

    const guest = data.guests.find(({ id }) => id === voucher.guestId);
    const drink = data.drinks.find(({ id }) => id === voucher.drinkId);
    if (!guest || guest.remaining === 0) return { status: "invalid" };
    if (!canServeDrink(drink)) return { status: "unavailable" };

    if (guest.remaining !== null) guest.remaining -= 1;
    drink.stock -= 1;
    const order = { id, guest: { ...guest }, drink: drink.name, scannedAt, remaining: guest.remaining, bartender };
    voucher.status = "redeemed";
    voucher.order = order;
    data.orders.unshift(order);
    return { status: "accepted", order };
  });
}

export function formatTime(timestamp) {
  return new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(timestamp);
}

export function localDate(timestamp) {
  const date = new Date(timestamp);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part) => String(part).padStart(2, "0")).join("-");
}
