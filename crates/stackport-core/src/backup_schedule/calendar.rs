use super::{unix_now, LATEST_START};
use crate::Result;
use cronexpr::{
    jiff::{civil::Date, tz::TimeZone, Timestamp, ToSpan, Zoned},
    parse_crontab, Crontab,
};
use serde::{Deserialize, Serialize};

const MAX_EXCEPTIONS: usize = 366;
const BAD_TIME: &str = "예약 시각을 계산할 수 없습니다.";

#[derive(Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BackupCalendar {
    expression: String,
    time_zone: String,
    #[serde(default)]
    excluded_dates: Vec<String>,
}

#[derive(Serialize)]
pub struct CalendarOccurrence {
    pub(crate) at: i64,
    local_time: String,
}

pub fn preview_backup_calendar(input: BackupCalendar) -> Result<Vec<CalendarOccurrence>> {
    let schedule = CalendarSchedule::parse(&input)?;
    let mut after = unix_now()?;
    let mut preview = Vec::with_capacity(5);
    while preview.len() < 5 {
        let Some(next) = schedule.next_after(after)? else { break };
        after = next.at;
        preview.push(next);
    }
    if preview.is_empty() { return Err(super::NO_CALENDAR_OCCURRENCE.into()); }
    Ok(preview)
}

pub(super) struct CalendarSchedule {
    cron: Crontab,
    zone: TimeZone,
    excluded: Vec<Date>,
}

impl CalendarSchedule {
    pub(super) fn parse(input: &BackupCalendar) -> Result<Self> {
        let expression = input.expression.trim();
        if expression.len() > 160 || expression.split_ascii_whitespace().count() != 5 || !expression.is_ascii() {
            return Err("cron은 분, 시, 일, 월, 요일의 5개 필드로 입력하세요.".into());
        }
        let zone = input.time_zone.trim();
        if zone.is_empty() || zone.len() > 80 || zone.contains(char::is_whitespace) || !zone.is_ascii() {
            return Err("Asia/Seoul 또는 UTC와 같은 IANA 시간대를 입력하세요.".into());
        }
        let timezone = TimeZone::get(zone).map_err(|_| "등록된 IANA 시간대를 입력하세요.")?;
        let cron = parse_crontab(&format!("{expression} {zone}"))
            .map_err(|_| "cron 식의 분, 시, 일, 월, 요일 값과 범위를 확인하세요.")?;
        if input.excluded_dates.len() > MAX_EXCEPTIONS {
            return Err("제외 날짜를 최대 366개까지 입력할 수 있습니다.".into());
        }
        let mut excluded = Vec::with_capacity(input.excluded_dates.len());
        for date in &input.excluded_dates {
            let date = date.trim();
            if date.len() != 10 || date.as_bytes()[4] != b'-' || date.as_bytes()[7] != b'-' {
                return Err("제외 날짜는 YYYY-MM-DD 형식으로 입력하세요.".into());
            }
            excluded.push(date.parse::<Date>().map_err(|_| "제외 날짜의 연도, 월과 일을 확인하세요.")?);
        }
        excluded.sort_unstable();
        excluded.dedup();
        Ok(Self { cron, zone: timezone, excluded })
    }

    pub(super) fn is_excluded(&self, at: i64) -> Result<bool> {
        Ok(self.excluded.binary_search(&self.local_date(at)?).is_ok())
    }

    pub(super) fn local_date(&self, at: i64) -> Result<Date> {
        Ok(Timestamp::from_second(at).map_err(|_| BAD_TIME)?.to_zoned(self.zone.clone()).date())
    }

    /// One occurrence per excluded local date, starting with the first matching tick after the cursor.
    pub(super) fn excluded_after(&self, at: i64) -> Result<Vec<i64>> {
        let start_date = self.local_date(at)?;
        let mut excluded = Vec::new();
        for &date in self.excluded.iter().filter(|&&date| date >= start_date) {
            let start = date.at(0, 0, 0, 0).to_zoned(self.zone.clone()).map_err(|_| BAD_TIME)?;
            if start.date() != date { continue; }
            let end = start.end_of_day().map_err(|_| BAD_TIME)?.timestamp().as_second().min(LATEST_START);
            let after = at.max(start.timestamp().as_second() - 1);
            if let Some(tick) = self.next_tick(after, end)? {
                excluded.push(tick.timestamp().as_second());
            }
        }
        Ok(excluded)
    }

    pub(super) fn next_after(&self, at: i64) -> Result<Option<CalendarOccurrence>> {
        let mut cursor = at;
        while let Some(next) = self.next_tick(cursor, LATEST_START)? {
            if self.excluded.binary_search(&next.date()).is_err() {
                return Ok(Some(occurrence(next)));
            }
            cursor = next.end_of_day().map_err(|_| BAD_TIME)?.timestamp().as_second();
        }
        Ok(None)
    }

    fn next_tick(&self, at: i64, end: i64) -> Result<Option<Zoned>> {
        let mut cursor = Timestamp::from_second(at).map_err(|_| BAD_TIME)?;
        while cursor.as_second() < end {
            let next = match self.cron.find_next(cursor) {
                Ok(next) => next,
                Err(_) => {
                    // cronexpr searches one four-year window at a time.
                    cursor = cursor.to_zoned(self.zone.clone()).checked_add(4.years()).map_err(|_| BAD_TIME)?.timestamp();
                    continue;
                }
            };
            if next.timestamp().as_second() > end { break; }
            cursor = next.timestamp();
            let first = self.zone.to_ambiguous_timestamp(next.datetime()).earlier().map_err(|_| BAD_TIME)?;
            if first == cursor {
                return Ok(Some(next));
            }
        }
        Ok(None)
    }
}

fn occurrence(time: Zoned) -> CalendarOccurrence {
    CalendarOccurrence {
        at: time.timestamp().as_second(),
        local_time: time.strftime("%Y-%m-%d %H:%M %:z").to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schedule(expression: &str, time_zone: &str, excluded: &[&str]) -> BackupCalendar {
        BackupCalendar {
            expression: expression.into(), time_zone: time_zone.into(),
            excluded_dates: excluded.iter().map(|date| (*date).into()).collect(),
        }
    }

    fn timestamp(value: &str) -> i64 { value.parse::<Timestamp>().unwrap().as_second() }

    fn next(schedule: &CalendarSchedule, after: &str) -> i64 {
        schedule.next_after(timestamp(after)).unwrap().unwrap().at
    }

    #[test]
    fn local_weekday_and_monthly_rules_honor_excluded_dates() {
        let weekly = CalendarSchedule::parse(&schedule("0 9 * * MON", "Asia/Seoul", &["2026-01-05"])).unwrap();
        assert_eq!(next(&weekly, "2026-01-01T00:00:00Z"), timestamp("2026-01-12T00:00:00Z"));
        assert_eq!(weekly.excluded_after(timestamp("2026-01-01T00:00:00Z")).unwrap(), [timestamp("2026-01-05T00:00:00Z")]);
        assert!(weekly.is_excluded(timestamp("2026-01-04T19:00:00Z")).unwrap());
        let monthly = CalendarSchedule::parse(&schedule("30 18 15 * *", "Asia/Seoul", &[])).unwrap();
        assert_eq!(next(&monthly, "2026-01-15T09:30:00Z"), timestamp("2026-02-15T09:30:00Z"));
    }

    #[test]
    fn excluded_dates_only_report_matching_local_times_once_per_date() {
        let schedule = CalendarSchedule::parse(&schedule("0,30 1 * * SUN", "America/New_York",
            &["2026-11-01", "2026-11-02", "2026-11-08", "2026-11-08"])).unwrap();
        let ticks = schedule.excluded_after(timestamp("2026-11-01T05:00:00Z")).unwrap();
        assert_eq!(ticks, [timestamp("2026-11-01T05:30:00Z"), timestamp("2026-11-08T06:00:00Z")]);
        let after_first_occurrences = schedule.excluded_after(timestamp("2026-11-01T05:30:00Z")).unwrap();
        assert_eq!(after_first_occurrences, [timestamp("2026-11-08T06:00:00Z")]);
    }

    #[test]
    fn spring_gap_is_skipped_and_fall_overlap_fires_once() {
        let spring = CalendarSchedule::parse(&schedule("30 2 * * *", "America/New_York", &[])).unwrap();
        assert_eq!(next(&spring, "2026-03-08T05:00:00Z"), timestamp("2026-03-09T06:30:00Z"));
        let fall = CalendarSchedule::parse(&schedule("30 1 * * *", "America/New_York", &[])).unwrap();
        assert_eq!(next(&fall, "2026-11-01T04:00:00Z"), timestamp("2026-11-01T05:30:00Z"));
        assert_eq!(next(&fall, "2026-11-01T05:30:00Z"), timestamp("2026-11-02T06:30:00Z"));
    }

    #[test]
    fn malformed_and_unreachable_schedules_fail_validation() {
        for input in [schedule("0 12 * *", "UTC", &[]), schedule("60 12 * * *", "UTC", &[]),
            schedule("0 12 * * *", "wrong/zone", &[]), schedule("0 12 * * *", "UTC", &["2026-02-31"])] {
            assert!(CalendarSchedule::parse(&input).is_err());
        }
        let impossible = CalendarSchedule::parse(&schedule("0 12 31 FEB *", "UTC", &[])).unwrap();
        assert!(impossible.next_after(timestamp("2026-01-01T00:00:00Z")).unwrap().is_none());
    }
}
