# Project Spec Template

Copy this file to `projects/{your-project-slug}/spec.md` and fill it in.
Leave sections blank if you don't know yet — Claude will flag the gaps.

---

## Project Name
<!-- Short name used for folder and workflow naming. No spaces — use hyphens. -->
<!-- Example: customer-onboarding -->

## Purpose
<!-- What problem does this system solve? Who triggers it and why? -->

## Entry Point
<!-- How is the supervisor workflow triggered? -->
<!-- Options: webhook (HTTP POST), schedule (cron), manual, chat message -->

## Workflows

<!-- List every workflow. Mark one as SUPERVISOR, rest as SUB. -->
<!-- Example: -->
<!-- - [SUPERVISOR] Main orchestrator — receives input, calls subs, returns final output -->
<!-- - [SUB] Send welcome email — sends onboarding email, returns { status, result, error } -->
<!-- - [SUB] Create CRM record — creates contact in CRM, returns { status, result, error } -->

## Data Flow

### Input to Supervisor
<!-- What data arrives at the entry point? -->
<!-- Example: { "email": "string", "name": "string", "plan": "string" } -->

### Supervisor → each Sub
<!-- What does the supervisor pass to each sub-workflow? -->

### Each Sub → Supervisor
<!-- What does each sub return? (follows standard contract: { status, result, error }) -->

### Final Output
<!-- What does the supervisor return at the end? -->

## Credentials Needed
<!-- Which external services does this project use? -->
<!-- Reference credential-map.md for the exact names to use -->

## Notes
<!-- Edge cases, constraints, things Claude should know -->
<!-- Example: "The CRM step should be skipped if the user already exists" -->
