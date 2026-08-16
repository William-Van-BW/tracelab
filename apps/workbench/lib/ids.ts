export function nextSequentialId(prefix: string, existing: string[]) {
  let n = 1;
  const used = new Set(existing);
  while (used.has(`${prefix}_${n}`)) n += 1;
  return `${prefix}_${n}`;
}

export function newRunId() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  // Keep the readable timestamp, but append a short random suffix so two Runs
  // created in the same second can never collide — a collision would let the
  // records API's ON CONFLICT DO UPDATE silently overwrite one Run with another.
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const suffix = Math.random().toString(36).slice(2, 6);
  return `run_${stamp}_${suffix}`;
}

export function downloadJson(name: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
