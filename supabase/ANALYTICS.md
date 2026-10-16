# Usage analytics

Counts, durations and costs per feature, for a dashboard. No content (speech, captions, notes) is stored.

## Where the numbers come from

| Feature label | What it is | Source table | Provider cost |
|---|---|---|---|
| `live_translate` | Phiên dịch: live speech | `soniox_grants.feature` | realtime speech per hour |
| `meeting_note` | Ghi chú cuộc họp: live speech | `soniox_grants.feature` | realtime speech per hour, each stream |
| `file_note` | Ghi chú từ file or link | `file_jobs.billing_source = 'file'` | async speech per hour |
| `watch_listen` | Xem Video without captions: audio recognition + translation | `file_jobs` (`watch`) + `ai_usage` | async speech + AI |
| `watch_captions` | Xem Video with captions: translation + watched time | `ai_usage` + `watch_usage_sessions` | AI |
| `watch_chat` | Questions about a video | `ai_usage` | AI |
| `summary`, `title` | Meeting/file summaries and titles | `ai_usage` | AI |
| `note_chat`, `live_chat` | Questions about a note / during a meeting | `ai_usage` | AI |
| `translate_paragraph` | Paragraph translation of a live transcript | `ai_usage` | AI |
| `writer` | Document writing | `ai_usage` | AI |
| `han_repair` | Removing stray Chinese characters from answers | `ai_usage` | AI |
| `unknown` | Rows from before 2026-10-16 or from older app versions | | |

AI cost is the provider's own figure (`ai_usage.cost_usd`). Speech cost is audio time × the rate in
`public.cost_rates`. When a price changes, add a row with a new `valid_from`; do not edit old rows:

```sql
insert into public.cost_rates (item, rate, valid_from, note) values ('speech_realtime', 0.11, '2026-12-01', 'New price');
```

## Views (schema `analytics`, days in Vietnam time)

- `feature_daily`: day × feature: users, usage seconds, AI requests, cost (USD)
- `ai_daily`, `speech_daily`, `file_daily`, `watch_daily`: the detail behind it
- `active_daily`: distinct active users per day
- `revenue_daily`: paid orders, revenue (VND), seconds sold
- `margin_daily`: revenue vs cost (VND) and active users per day
- `user_economics`: per user: revenue, minutes used, cost, last activity

The `analytics` schema is not exposed through the API, so app users cannot read it.

## Dashboard setup (Metabase)

1. In the Supabase SQL editor, give the read-only role a password (keep it in a password manager, never in git):
   ```sql
   alter role analytics_reader with login password '<strong password>';
   ```
2. In Metabase, add a PostgreSQL database with the session pooler details from
   Supabase → Project Settings → Database → Connection string → Session pooler:
   - host `aws-…pooler.supabase.com`, port `5432`, database `postgres`
   - user `analytics_reader.<project-ref>`, the password above, SSL on
   - Schemas: only `analytics`
3. Build the questions below and put them on one dashboard with a date filter.

## Suggested questions

Cost per feature, last 30 days:
```sql
select feature, sum(usage_seconds) / 3600 as hours, sum(ai_requests) as ai_requests, round(sum(cost_usd), 2) as cost_usd
from analytics.feature_daily where day >= current_date - 30 group by feature order by cost_usd desc;
```

Daily revenue, cost and margin:
```sql
select day, revenue_vnd, cost_vnd, margin_vnd, active_users from analytics.margin_daily order by day;
```

Share of usage time per feature, by week:
```sql
select date_trunc('week', day) as week, feature, sum(usage_seconds) / 3600 as hours
from analytics.feature_daily where usage_seconds > 0 group by 1, 2 order by 1;
```

Cost of one hour of each feature (what a sold hour must cover):
```sql
select feature, round(sum(cost_usd) / nullif(sum(usage_seconds) / 3600, 0), 4) as usd_per_hour
from analytics.feature_daily where usage_seconds > 0 and day >= current_date - 30 group by feature;
```

Costliest users and whether they pay:
```sql
select email, revenue_vnd, round(used_seconds / 3600.0, 1) as hours_used, cost_usd, last_active_at
from analytics.user_economics order by cost_usd desc limit 20;
```

Sign-up to first purchase:
```sql
select count(*) as users, count(*) filter (where orders > 0) as buyers,
       round(100.0 * count(*) filter (where orders > 0) / nullif(count(*), 0), 1) as percent
from analytics.user_economics;
```
