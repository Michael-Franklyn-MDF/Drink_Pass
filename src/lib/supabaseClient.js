import { createClient } from "@supabase/supabase-js";
import { getAppRole } from "../ui.jsx";

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();

const role = getAppRole();
export const supabase = role !== "cards" && url && key ? createClient(url, key, {
  auth: { storageKey: `drink-pass-auth-${role}` },
}) : null;
