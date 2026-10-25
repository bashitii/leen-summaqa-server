-- Contact form messages (the site has no email system yet, so messages are stored and shown in the admin).
create table contact_messages (
  id uuid primary key default gen_random_uuid(),
  name text, email text not null, phone text, message text not null,
  is_handled boolean not null default false,
  created_at timestamptz not null default now()
);
create index contact_messages_created_idx on contact_messages(created_at desc);
alter table contact_messages enable row level security;   -- no policies on purpose: only the API (service role) reads or writes it
