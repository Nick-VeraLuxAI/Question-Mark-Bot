# Full Upgrade Rollout Checklist

## 0) Prerequisites
- Ensure Postgres is reachable and `DATABASE_URL` is set.
- Ensure Redis is reachable and `REDIS_URL` is set.
- Confirm both API and worker processes can run in target environment.

## 1) Schema and Migration
- Run `npx prisma migrate dev --name full_upgrade_hardening` in local/dev.
- Run `npx prisma migrate deploy` in staging/prod.
- Run `npx prisma generate` after migration.

## 2) Runtime Processes
- API: `npm run start`
- Worker: `npm run worker`
- Verify `/api/health` and `/api/ready` both return healthy responses.

## 3) Feature Flag Strategy (Per Tenant)
Roll out in this order, enabling one tenant cohort at a time.

1. **Observability only**
   - Keep enforcement off.
   - Enable metrics and alerts data collection.

2. **Async reliability**
   - `ADMIN_LOG_ASYNC=1`
   - Keep local fallback on: `LOG_FALLBACK_LOCAL_ON_FAIL=1`

3. **Safety soft mode**
   - `BLOCK_PROMPT_INJECTION=0`
   - Collect guardrail detections without blocking.

4. **Memory and prompt versions**
   - Activate prompt variants in `PromptVersion` per tenant.
   - Verify no reply regressions for selected tenants.

5. **Model caps (monitor mode first)**
   - Configure `Tenant.settings.costCapUsd`.
   - Keep high threshold initially, then tighten after 7 days.

6. **Security hardening**
   - `STRICT_TENANT_BINDING=1` for trusted SSO-integrated tenants.
   - Move `PLATFORM_COOKIE_SAMESITE=Strict` where flow permits.

7. **Safety enforce mode**
   - `BLOCK_PROMPT_INJECTION=1` after low false-positive rate is confirmed.

## 4) Verification Checklist
- `npm test` passes.
- `npm run smoke:prod` passes with `SMOKE_TENANT` set.
- `/message` works for:
  - normal chat flow
  - contact flow (lead capture)
  - blocked injection test case (when enabled)
- Worker queue depth remains stable under load.
- Alerts are created for synthetic threshold breach tests.

## 5) Rollback Plan
- Disable strict features quickly via env flags:
  - `BLOCK_PROMPT_INJECTION=0`
  - `STRICT_TENANT_BINDING=0`
  - `ADMIN_LOG_ASYNC=0`
- Keep API serving via synchronous paths while diagnosing queue/Redis issues.
- Revert prompt variants by setting `PromptVersion.isActive=false` per tenant.
