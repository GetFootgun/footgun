export function clean(s) {
  return String(s ?? "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
