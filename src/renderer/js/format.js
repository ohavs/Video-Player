// Time formatting. Every duration in the UI passes through here so a bookmark
// label, a tooltip and the clock in the control bar never disagree.

export function formatTime(seconds, { forceHours = false } = {}) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (h > 0 || forceHours) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

// Both sides of the clock share a width so digits do not jitter as time passes.
export function formatPair(current, duration) {
  const forceHours = duration >= 3600;
  return {
    current: formatTime(current, { forceHours }),
    duration: formatTime(duration, { forceHours }),
  };
}

// "1:23" / "1:02:03" / "83" -> seconds. Returns null when unparseable.
export function parseTime(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(':').map((p) => p.trim());
  if (parts.some((p) => p === '' || !/^\d+(\.\d+)?$/.test(p))) return null;
  const numbers = parts.map(Number);
  if (numbers.length === 1) return numbers[0];
  if (numbers.length === 2) return numbers[0] * 60 + numbers[1];
  if (numbers.length === 3) return numbers[0] * 3600 + numbers[1] * 60 + numbers[2];
  return null;
}

export function formatSpeed(rate) {
  // 1 -> "Normal", 1.5 -> "1.5×", 2 -> "2×"
  if (Math.abs(rate - 1) < 0.001) return 'Normal';
  const text = Number(rate.toFixed(2)).toString();
  return `${text}×`;
}

// The control bar needs a number even at 1×, because a button that reads
// "Normal" is wider than the speeds it switches between and makes the bar jump.
export function formatSpeedShort(rate) {
  return `${Number(Number(rate).toFixed(2))}×`;
}

export function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatRelativeDate(timestamp) {
  if (!timestamp) return '';
  const diff = Date.now() - timestamp;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return 'just now';
  if (diff < hour) return `${Math.floor(diff / minute)} min ago`;
  if (diff < day) return `${Math.floor(diff / hour)} h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} d ago`;
  return new Date(timestamp).toLocaleDateString();
}

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
