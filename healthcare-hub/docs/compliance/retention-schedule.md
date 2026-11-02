# Retention schedule configuration

Retention is configured per organisation in **Settings → Data protection**. The system ships with
**placeholder** rules that do nothing until the organisation records the basis from its own approved
schedule (for example the NHS Records Management Code of Practice) and approves each rule.

| Category                | Placeholder | Counted from                | What the system does once approved                                                                     |
| ----------------------- | ----------- | --------------------------- | ------------------------------------------------------------------------------------------------------ |
| Patient contact details | 96 months   | Journey date                | Review alert, or **anonymise** (name replaced, phone removed) if the rule's action is set to anonymise |
| Journey records         | 96 months   | Journey date                | Review alert                                                                                           |
| Staff HR records        | 72 months   | Date the person left        | Review alert                                                                                           |
| DBS records             | 6 months    | Date the check was recorded | Review alert                                                                                           |
| Event records           | 120 months  | Date the event occurred     | Review alert                                                                                           |
| Complaints              | 120 months  | Date received               | Review alert                                                                                           |
| Safeguarding            | 300 months  | Date the concern was raised | Review alert                                                                                           |
| Audit records           | 72 months   | Audit due date              | Review alert                                                                                           |
| Audit log               | 72 months   | Date of the action          | Review alert (the hash-chained log is never deleted by the system)                                     |

- The placeholder figures are **not advice**: the organisation must confirm each period.
- Legal holds (organisation, staff, job, event, vehicle) stop retention for their scope.
- Every run with something to do is recorded in the immutable retention log.
