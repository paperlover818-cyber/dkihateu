-- 每个账号针对每道题的一条独立笔记
create table if not exists public.user_notes (
  user_id uuid not null references auth.users(id) on delete cascade,
  question_id text not null,
  content text not null default '',
  updated_at timestamptz not null default now(),
  primary key (user_id, question_id)
);

alter table public.user_notes enable row level security;

drop policy if exists "Users can read their own notes" on public.user_notes;
create policy "Users can read their own notes"
  on public.user_notes for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own notes" on public.user_notes;
create policy "Users can insert their own notes"
  on public.user_notes for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own notes" on public.user_notes;
create policy "Users can update their own notes"
  on public.user_notes for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own notes" on public.user_notes;
create policy "Users can delete their own notes"
  on public.user_notes for delete
  using (auth.uid() = user_id);
