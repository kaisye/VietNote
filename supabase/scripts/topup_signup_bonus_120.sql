-- One-off: bring accounts that signed up with a smaller bonus up to 120 minutes.
-- Safe to run twice: the note marks who already received it.
select p.email, public.add_credit(p.id, 7200 - b.bonus, 'admin', 'signup bonus top-up to 120 min') as new_balance_seconds
from (select user_id, sum(delta_seconds) as bonus from public.credit_ledger
      where reason = 'signup_bonus' group by user_id) b
join public.profiles p on p.id = b.user_id
where b.bonus < 7200
  and not exists (select 1 from public.credit_ledger l
                  where l.user_id = b.user_id and l.note = 'signup bonus top-up to 120 min');
