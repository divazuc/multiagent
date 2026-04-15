# Credential Map

Maps service names to the credential names used in your n8n instance.
Claude uses these names when generating credential placeholder objects.

Update this file whenever you add a new credential to n8n.

---

| Service | Credential Name in n8n | Type |
|---|---|---|
| Anthropic API | `ANTHROPIC_HTTP_HEADER_AUTH` | Header Auth |
| Supabase (general) | `Postgres_Supabase` | Postgres |
| Supabase (multi-agent) | `multiagent_n8n_postgres` | Postgres |
| Supabase (WhatsApp agent) | `Whatsapp_agent_DB` | Postgres |

---

Add new rows as you set up more credentials in n8n.
