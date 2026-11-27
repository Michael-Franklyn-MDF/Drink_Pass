import { useSyncExternalStore } from "react";
import { QR_PREFIX } from "../demoEventStore.js";
import { getAppRole, isDemoMode } from "../ui.jsx";
import { supabase } from "./supabaseClient.js";

const params = new URLSearchParams(window.location.search);
const role = getAppRole();
export const backendMode = role !== "cards" && params.get("backend") === "1" && !isDemoMode();
const eventId = params.get("event");
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const empty = { guests: [], drinks: [], orders: [] };
const listeners = new Set();
let state = empty;
let version = 0;

async function rpc(operation, args) {
  if (!supabase) throw new Error("Supabase is missing its local configuration.");
  if (eventId !== null && !uuid.test(eventId)) throw new Error("This event link is invalid.");
  const scope = eventId && operation !== "create_event" ? { p_event: eventId } : {};
  const { data, error } = await supabase.rpc(`drink_pass_${operation}`, { ...args, ...scope });
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
  const next = await rpc("state", { p_role: role });
  if (request === version) publish(next);
}

async function update(operation, args) {
  const result = await rpc(operation, args);
  // A refresh failure must never turn a committed write into a retry.
  void refreshEvent().catch(() => {});
  return result;
}

export function addGuests(profiles) {
  return update("approve", { p_profiles: profiles });
}

export function createEvent(id, name, date, defaultVouchers) {
  return rpc("create_event", {
    p_id: id, p_name: name, p_date: date, p_default_vouchers: defaultVouchers,
  });
}

function updateStock(action, values) {
  return update("stock", { p_action: action, p_values: values });
}

export const addDrink = (name, stock) => updateStock("add", { name, stock });
export const setStock = (id, stock) => updateStock("set", { id, stock });
export const restockDrink = (id, stock) => updateStock("restock", { id, stock });
export const setDrinkEnabled = (id, enabled) => updateStock("enable", { id, enabled });


export function scanVoucher(code, _bartender, online = navigator.onLine) {
  if (!online) return Promise.resolve({ status: "offline" });
  if (!code.startsWith(QR_PREFIX) || !uuid.test(code.slice(QR_PREFIX.length))) {
    return Promise.resolve({ status: "invalid" });
  }
  return update("redeem", { p_voucher: code.slice(QR_PREFIX.length) });
}
