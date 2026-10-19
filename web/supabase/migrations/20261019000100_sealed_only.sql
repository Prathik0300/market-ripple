-- add_connection is callable over the API, so it also refuses anything that is not a sealed envelope from the
-- web server (a raw key sent straight to the database would be stored unreadable to the pipeline, and in clear).
alter table public.connection_secrets
  add constraint sealed_envelope check (sealed ~ '^\{"v":1,"k":"[A-Za-z0-9+/=]{255}[A-Za-z0-9+/=]*","iv":"[A-Za-z0-9+/=]{16}","ct":"[A-Za-z0-9+/=]+","tag":"[A-Za-z0-9+/=]{24}"\}$');
