// Dates and times for the session CSVs: your computer's own local clock,
// written the way a person would, e.g. "Aug 18, 2026" and "3:46:51.175 PM".

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

/** Your computer's own local date, e.g. "Aug 18, 2026". Not UTC. */
export function formatLocalDate(epochMs: number): string {
  const d = new Date(epochMs)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
}

/** Your computer's own local time of day, e.g. "3:46:51.175 PM". Not UTC. */
export function formatLocalTimeOfDay(epochMs: number): string {
  const d = new Date(epochMs)
  let hours = d.getHours()
  const ampm = hours >= 12 ? 'PM' : 'AM'
  hours = hours % 12 || 12
  const minutes = String(d.getMinutes()).padStart(2, '0')
  const seconds = String(d.getSeconds()).padStart(2, '0')
  const millis = String(d.getMilliseconds()).padStart(3, '0')
  return `${hours}:${minutes}:${seconds}.${millis} ${ampm}`
}
