# Penetration test remediation log (SEC-04)

An independent penetration test is required before go-live. **No external test has been carried out
yet.** Record each finding here with its fix and retest.

| Ref | Finding | Severity | Component | Fix (commit) | Retest | Status |
| --- | ------- | -------- | --------- | ------------ | ------ | ------ |
|     |         |          |           |              |        |        |

## Pre-test self-review (build team)

| Area             | Check                                                                                                               | Result                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Tenant isolation | Generated suite probes every endpoint across organisations                                                          | Automated, passing            |
| Authorisation    | Every route declares its permission; OpenAPI coverage test matches controllers                                      | Automated, passing            |
| Injection        | Zod validation on every input; parameterised queries only; CSV formula injection guarded on export                  | Automated, passing            |
| Files            | Upload quarantine, scan and type check; signed short-lived links; export links cannot be replayed as evidence links | Automated, passing            |
| Secrets          | No secrets in the repository; production refuses development keys                                                   | Config tests passing          |
| Passive scan     | ZAP baseline weekly against staging                                                                                 | Runs after staging deployment |
