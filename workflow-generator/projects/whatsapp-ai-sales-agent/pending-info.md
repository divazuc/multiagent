# Pending Info

Information still needed to finalize this project.

- [ ] Future WhatsApp Cloud API (Meta) integration — input format will shift to { message: string, user_id: phone_number }; a message normalization layer and webhook verification step will be needed at that time.
- [ ] Escalation notifications (WhatsApp message to business owner, CRM task, Slack/email) are deferred to a future phase — currently escalation returns a flag only.
  - Note: will have a separate chat with the business owner via whatsapp conversation for escalations, system updates ,etc , these note will also be saved and show in the dedicated client dashboard/crm that we'll develope later on. not relevant for our current build.
- [ ] Additional language support beyond Hebrew and English is deferred to a future phase — architecture should not hardcode Hebrew-only logic.
  - Note: keep translations not hard coded for flexibility, but for the first mvp the platform will use hebrew as default language.
- [ ] CRM and Calendar credential integration is deferred — not required at MVP stage.
- [ ] Hebrew sentence pattern examples / persona training data to be provided by business owner during Demo Learning Phase setup.
- [ ] Future WhatsApp Cloud API credentials will need to be added to the credential map when WhatsApp integration is implemented.
- [ ] CRM, Calendar, and external notification integrations (Slack, email, WhatsApp owner alerts) are deferred to a future phase — escalation returns escalate:true flag only at MVP.
- [ ] Additional language support beyond Hebrew and English is deferred to a future phase — architecture must not hardcode Hebrew-only logic.
  - Note: duplicated item.
- [ ] Dedicated admin UI for setup onboarding is deferred to a future phase — unified webhook entry point used at MVP.
- [ ] WA_04_Setup Onboarding Flow generates conversational setup responses using natural language. Should these also be generated via Anthropic Claude (to maintain conversational feel and Hebrew naturalness), or is a deterministic state-machine script sufficient for the setup dialogue?
- [ ] WA_08_Demo Learning Phase: what format does the business owner use to respond during a simulation session — the same inbound webhook (session_mode = learning_mode already set), or a distinct payload structure that includes a marker identifying it as a training response vs. a simulated lead message?
- [ ] Multi-tenancy bootstrapping: when a brand-new session_id arrives that has no existing session record in the DB, should WA_02 auto-create a new session + a new business_id placeholder (triggering setup flow), or should business creation be a separate explicit API call before first message?
- [ ] WA_05 rewrite attempt limit: how many Claude rewrite attempts should WA_05 make before returning a failure/escalation signal to the supervisor? (Suggested default: 2 attempts)
