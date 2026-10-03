/** Five-field numeric cron in the execution environment's local timezone. */
export function nextCronOccurrence(expression: string, after: number): number {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Cron requires five fields: minute hour day month weekday');
  const parsed = fields.map((field, index) => parseField(field, [0, 0, 1, 1, 0][index], [59, 23, 31, 12, 7][index]));
  if (parsed[4].has(7)) parsed[4].add(0);
  const dayWildcard = fields[2].startsWith('*'); const weekWildcard = fields[4].startsWith('*');
  const date = new Date((Math.floor(after / 60) + 1) * 60000);
  const end = new Date(date); end.setFullYear(end.getFullYear() + 5);
  while (date < end) {
    const day = parsed[2].has(date.getDate()); const weekday = parsed[4].has(date.getDay());
    const dayMatches = dayWildcard ? weekday : weekWildcard ? day : day || weekday;
    if (!parsed[3].has(date.getMonth() + 1) || !dayMatches) {
      date.setDate(date.getDate() + 1); date.setHours(0, 0, 0, 0); continue;
    }
    if (parsed[1].has(date.getHours()) && parsed[0].has(date.getMinutes())) return date.getTime() / 1000;
    date.setTime(date.getTime() + 60000);
  }
  throw new Error('Cron has no occurrence in the next five years');
}
function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error('Unsupported cron field');
    const step = Number(match[2] ?? 1);
    if (!Number.isInteger(step) || step < 1 || step > max + 1) throw new Error('Invalid cron step');
    const range = match[1] === '*' ? [min, max] : match[1].split('-').map(Number);
    const start = range[0]; const end = range[1] ?? (match[2] ? max : start);
    if (start < min || end > max || start > end) throw new Error('Cron field is out of range');
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}
