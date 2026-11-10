import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import { describe, expect, it } from 'vitest';

import { TIMEZONE_OPTIONS } from './CronConfig';

dayjs.extend(utc);
dayjs.extend(timezone);

describe('TIMEZONE_OPTIONS', () => {
  // Bug: Tehran was missing, so Iranian users (the main user base) could not
  // schedule "every day at 07:30" in their own time — a task created from a
  // browser reporting another zone stayed on it with no way to correct it.
  it('offers Asia/Tehran at UTC+3:30', () => {
    const tehran = TIMEZONE_OPTIONS.find((o) => o.value === 'Asia/Tehran');

    expect(tehran).toBeDefined();
    expect(tehran?.offset).toContain('UTC+3:30');
    // Iran has had no DST since 2022: winter and summer are both +3:30.
    expect(dayjs.tz('2026-01-15T12:00:00', 'Asia/Tehran').utcOffset()).toBe(210);
    expect(dayjs.tz('2026-07-15T12:00:00', 'Asia/Tehran').utcOffset()).toBe(210);
  });

  it('only lists valid, unique IANA timezones', () => {
    const values = TIMEZONE_OPTIONS.map((o) => o.value);

    expect(new Set(values).size).toBe(values.length);
    for (const value of values) {
      expect(() => new Intl.DateTimeFormat('en-US', { timeZone: value })).not.toThrow();
    }
  });
});
