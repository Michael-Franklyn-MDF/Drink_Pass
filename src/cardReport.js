import { localDate } from "./eventStore.js";

const groups = [["staff", "Standard staff"], ["manager", "Managers"]];
const orderTime = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit", second: "2-digit" });

export const COUNT_COLUMNS = ["Guest name", "Staff ID", "Drinks"];
export const DETAIL_COLUMNS = ["Guest name", "Staff ID", "Bartender", "Date", "Time"];

export function cardReport(orders) {
  return groups.map(([role, title]) => {
    const counts = new Map();
    const details = [];
    for (const order of orders) {
      const guest = order.guest;
      if (guest.role !== role) continue;
      const staffId = guest.staffId ?? (guest.identifierType === "Staff ID" ? guest.identifier : "") ?? "";
      const key = guest.id ?? (staffId || guest.fullName);
      const entry = counts.get(key);
      if (entry) entry[2] += 1;
      else counts.set(key, [guest.fullName, staffId, 1]);
      details.push([
        guest.fullName, staffId, order.bartender, localDate(order.scannedAt), orderTime.format(order.scannedAt),
      ]);
    }
    const countRows = [...counts.values()].sort(([first], [second]) => first.localeCompare(second));
    return { role, title, countRows, detailRows: details, total: details.length };
  });
}

export function cardReportSheets(report) {
  return report.map(({ title, total, countRows, detailRows }) => ({
    sheet: title,
    data: [
      ["Total drinks", total], [],
      COUNT_COLUMNS, ...countRows, [],
      DETAIL_COLUMNS, ...detailRows,
    ],
  }));
}
