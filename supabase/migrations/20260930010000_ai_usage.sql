-- One row per LLM request made through the ai-complete Edge Function
-- (summaries, paragraph translation, meeting titles). Used for cost tracking
-- and per-user rate limiting; written only by the service role.
create table public.ai_usage (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles on delete cascade,
  model text not null,
  prompt_tokens integer not null default 0,
  completion_tokens integer not null default 0,
  cost_usd numeric(12, 8),
  created_at timestamptz not null default now()
);
create index ai_usage_user_recent on public.ai_usage (user_id, created_at desc);

alter table public.ai_usage enable row level security;
create policy "read own ai usage" on public.ai_usage for select using (auth.uid() = user_id);
