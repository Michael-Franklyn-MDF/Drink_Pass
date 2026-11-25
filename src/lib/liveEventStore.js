import { useSyncExternalStore } from "react";
import { QR_PREFIX } from "../demoEventStore.js";
import { getAppRole, isDemoMode } from "../ui.jsx";
import { supabase } from "./supabaseClient.js";

export const backendMode = new URLSearchParams(window.location.search).get("backend") === "1" && !isDemoMode();
const role = getAppRole();
const sessionKey = `drink-pass-guest-session-${role}`;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const empty = { guests: [], drinks: [], vouchers: {}, orders: [], sessions: {} };
const listeners = new Set();
let state = empty;
let version = 0;

function getSessionId() {
  const session = localStorage.getItem(sessionKey);
  return uuid.test(session ?? "") ? session : null;
}

async function rpc(operation, args) {
  if (!supabase) throw new Error("Supabase is missing its local configuration.");
  const { data, error } = await supabase.rpc(`drink_pass_${operation}`, args);
  if (error) throw new Error(error.message);
  return data;
}

function publish(next) {
  state = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useEvent() {
  return useSyncExternalStore(subscribe, () => state);
}

export function clearEvent() {
  version += 1;
  publish(empty);
}

export async function refreshEvent() {
  const request = ++version;
  const next = await rpc("state", { p_role: role, p_session: getSessionId() });
  if (request === version) publish(next);
}

async function update(operation, args) {
  const result = await rpc(operation, args);
  // A refresh failure must never turn a committed write into a retry.
  void refreshEvent().catch(() => {});
  return result;
}

export async function registerGuest({ invite, ...profile }) {
  if (!uuid.test(invite)) throw new Error("Enter the invitation code supplied by Admin.");
  const session = getSessionId() ?? crypto.randomUUID();
  localStorage.setItem(sessionKey, session);
  const allowed = await update("register", { p_profile: profile, p_invite: invite, p_session: session });
  if (!allowed) throw new Error("The invitation and guest details didn’t match, or the invitation has already been used.");
}

export function addGuests(profiles) {
  return update("approve", { p_profiles: profiles });
}

function updateStock(action, values) {
  return update("stock", { p_action: action, p_values: values });
}

export const addDrink = (name, stock) => updateStock("add", { name, stock });
export const setStock = (id, stock) => updateStock("set", { id, stock });
export const restockDrink = (id, stock) => updateStock("restock", { id, stock });
export const setDrinkEnabled = (id, enabled) => updateStock("enable", { id, enabled });

export async function openVoucher(guestId, drinkId) {
  const voucher = await update("voucher", { p_session: getSessionId(), p_action: "open", p_id: drinkId });
  if (voucher && state.sessions[role] === guestId && !state.vouchers[voucher.id]) {
    publish({ ...state, vouchers: { ...state.vouchers, [voucher.id]: voucher } });
  }
  return voucher;
}

export function cancelVoucher(id) {
  return update("voucher", { p_session: getSessionId(), p_action: "cancel", p_id: id });
}

export function scanVoucher(code, _bartender, online = navigator.onLine) {
  if (!online) return Promise.resolve({ status: "offline" });
  if (!code.startsWith(QR_PREFIX) || !uuid.test(code.slice(QR_PREFIX.length))) {
    return Promise.resolve({ status: "invalid" });
  }
  return update("redeem", { p_voucher: code.slice(QR_PREFIX.length) });
}
