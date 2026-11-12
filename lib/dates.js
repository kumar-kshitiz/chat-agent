import { localDate } from './config.js';

const weekdays = [
  'sunday', 'monday', 'tuesday', 'wednesday',
  'thursday', 'friday', 'saturday'
];

const months = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'
];

const monthPattern = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const dayThenMonth = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${monthPattern}(?:\\s+(20\\d{2}))?\\b`);
const monthThenDay = new RegExp(`\\b${monthPattern}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b`);

function dateText(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, count) {
  return new Date(date.getTime() + count * 86_400_000);
}

function oneDay(date) {
  return { start: date, end: date, label: date };
}

function isRealDate(value) {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && dateText(parsed) === value;
}

function resolveNamedDate(question, today) {
  const dayFirst = question.match(dayThenMonth);
  const monthFirst = dayFirst ? null : question.match(monthThenDay);
  const match = dayFirst || monthFirst;

  if (!match) return null;

  const day = Number(dayFirst ? match[1] : match[2]);
  const monthName = dayFirst ? match[2] : match[1];
  const month = months.findIndex(name => name.startsWith(monthName.slice(0, 3))) + 1;
  const explicitYear = match[3];
  let year = Number(explicitYear || today.slice(0, 4));

  function candidateDate() {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  // Without a year, use the most recent occurrence of that date.
  if (!explicitYear && candidateDate() > today) year--;

  const date = candidateDate();
  return month > 0 && isRealDate(date) ? oneDay(date) : null;
}

// Use the user's configured time zone when interpreting relative dates.
export function resolveDateReference(query, now = new Date()) {
  const today = localDate(now);
  const calendarDay = new Date(`${today}T00:00:00Z`);
  const question = query.toLowerCase();

  const numericDate = question.match(/\b20\d{2}-\d{2}-\d{2}\b/);
  if (numericDate && isRealDate(numericDate[0])) {
    return oneDay(numericDate[0]);
  }

  const namedDate = resolveNamedDate(question, today);
  if (namedDate) return namedDate;

  if (/\blast week\b/.test(question)) {
    const daysSinceMonday = (calendarDay.getUTCDay() + 6) % 7;
    const end = addDays(calendarDay, -daysSinceMonday - 1);
    const start = addDays(end, -6);
    return {
      start: dateText(start),
      end: dateText(end),
      label: `${dateText(start)} to ${dateText(end)}`
    };
  }

  const weekday = question.match(/\b(?:(last|this)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);

  if (weekday) {
    const targetDay = weekdays.indexOf(weekday[2]);
    let daysAgo = (calendarDay.getUTCDay() - targetDay + 7) % 7;

    if (weekday[1] === 'last') daysAgo += 7;
    if (weekday[1] === 'this') {
      const todayFromMonday = (calendarDay.getUTCDay() + 6) % 7;
      const targetFromMonday = (targetDay + 6) % 7;
      daysAgo = todayFromMonday - targetFromMonday;
    }

    return oneDay(dateText(addDays(calendarDay, -daysAgo)));
  }

  if (/\byesterday\b/.test(question)) {
    return oneDay(dateText(addDays(calendarDay, -1)));
  }

  return null;
}
