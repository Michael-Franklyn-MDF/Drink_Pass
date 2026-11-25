import * as demo from "./demoEventStore.js";
import * as live from "./lib/liveEventStore.js";

export {
  canServeDrink, DEMO_BARTENDER, formatTime, IDENTIFIER_TYPES, INITIAL_VOUCHERS,
  localDate, managerInvitation, QR_PREFIX, VOUCHER_DURATION,
} from "./demoEventStore.js";

export const { backendMode } = live;

export const {
  useEvent, registerGuest, addGuests, addDrink, setStock, restockDrink,
  setDrinkEnabled, openVoucher, cancelVoucher, scanVoucher,
} = backendMode ? live : demo;
