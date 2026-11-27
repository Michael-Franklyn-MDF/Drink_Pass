import * as demo from "./demoEventStore.js";
import * as live from "./lib/liveEventStore.js";

export {
  canServeDrink, DEMO_BARTENDER, formatTime, IDENTIFIER_TYPES, INITIAL_VOUCHERS,
  localDate, QR_PREFIX,
} from "./demoEventStore.js";

export const { backendMode } = live;

export const {
  useEvent, addGuests, addDrink, setStock, restockDrink, setDrinkEnabled, scanVoucher,
} = backendMode ? live : demo;
