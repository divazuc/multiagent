# Credential Map

Maps service names to the credential names used in your n8n instance.
Claude uses these names when generating credential placeholder objects.

Update this file whenever you add a new credential to n8n.

---

| Service | Credential Name in n8n | Type |
|---|---|---|
| Anthropic API | `ANTHROPIC_HTTP_HEADER_AUTH` | Header Auth |
| Postgres / Supabase | `Postgres_Supabase` | Postgres |
| Slack | `Slack account` | Slack OAuth |
| Google Sheets | `Google Sheets account` | Google OAuth |
| HTTP APIs (generic) | `Header Auth` | Header Auth |

---

Add new rows as you set up more credentials in n8n.
