import fs from 'node:fs';

export function loadEnv(path = '.env') {
  if (!fs.existsSync(path)) return;

  for (const line of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]]) continue;

    const name = match[1];
    const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
    process.env[name] = value;
  }
}

export function localDate(date = new Date()) {
  const timeZone = process.env.APP_TIME_ZONE || 'Asia/Kolkata';
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  return formatter.format(date);
}

export function localDateTime(date = new Date()) {
  const timeZone = process.env.APP_TIME_ZONE || 'Asia/Kolkata';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short'
  }).formatToParts(date);

  const value = name => parts.find(part => part.type === name)?.value;
  const day = `${value('year')}-${value('month')}-${value('day')}`;
  const time = `${value('hour')}:${value('minute')}:${value('second')}`;
  const zoneLabel = ['Asia/Kolkata', 'Asia/Calcutta'].includes(timeZone)
    ? 'IST'
    : value('timeZoneName');
  return `${day} ${time} ${zoneLabel} (${timeZone})`;
}
