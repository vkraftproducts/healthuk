# Administrator guide

For the organisation administrator and the registered manager setting up and running Healthcare Hub.
Running it on a development machine is covered in `RUN_LOCALLY.md`.

## 1. First set-up

1. **Organisation and locations.** In Settings → Organisation and locations, add each base or
   station. Locations scope people and data: someone with a location-scoped role sees only that
   location.
2. **Users and roles.** In Settings → Users and roles, invite people by work email and give each a
   role:
   - Registered manager, director, organisation admin.
   - HR lead, fleet lead, governance lead.
   - Dispatcher, crew, auditor (read-only).

   You can build custom roles from the permission list. Roles based on dispatcher or crew can never
   be given sensitive permissions such as DBS, safeguarding, user management, full export or
   privacy. Sign-in is through Microsoft Entra External ID with MFA.

3. **Requirement library.** Adopt the Ambulance pack items that apply. Their intervals marked
   "proposed" need confirming. Then approve and publish their versions. In this release, adoption
   and publishing are done through the API (`POST /api/v1/requirements/templates/{id}/adopt` and
   `…/versions/{versionId}/publish`); a library screen is planned. Nothing turns green on upload
   alone: evidence must be verified by someone else.
4. **Import existing records** (Settings → Import and export).
   - Upload staff or vehicles as CSV and read the preview. Errors and duplicates are listed per row.
   - Choose **Import**. You can roll back for 7 days. Rollback withdraws the records: staff become
     leavers and vehicles go off road. History is kept.
   - For the compliance workbook, save each sheet as CSV and stage it. Classify each row and propose
     its requirement. A governance reviewer approves, and the requirement is then published as a
     draft in the library.
5. **Data protection** (Settings → Data protection, needs `privacy.manage`). For every retention
   rule, record the basis from your approved schedule, then approve it. The placeholders do nothing
   until you do.

## 2. Day-to-day administration

| Task                      | Where                                                                  | Notes                                                                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Someone leaves            | Staff → profile → Leaver                                               | Their access ends on their next request, and their phone wipes itself on next contact                                                                       |
| Lost or stolen phone      | Settings → Users and roles → Revoke access (re-invite them afterwards) | The phone is refused and wipes itself on its next contact. A crew member who still has the phone can sign out in the app instead                            |
| Support from the supplier | Settings → Support access                                              | Time-limited, read-only, approved by you, and logged                                                                                                        |
| Check the audit trail     | Settings → Audit log → Verify chain                                    | The chain is also verified nightly, with an alert if it is ever broken                                                                                      |
| Subject access request    | Settings → Data protection                                             | Log it the day it arrives (the due date is one calendar month later). Verify the person's identity, build the export, review it, then record the disclosure |
| Personal data breach      | Settings → Data protection                                             | Record it as soon as it is discovered. The 72-hour ICO clock starts at discovery. Record the risk and the reportability decision with reasons               |
| Monthly management pack   | Reports → Monthly management pack                                      | A PDF for the board. Internal measures only, not a CQC rating                                                                                               |
| Full data export          | Settings → Import and export                                           | A ZIP of every table and evidence file with stable IDs. Logged                                                                                              |

## 3. Safety rules you cannot switch off

- **Statutory and safety-critical failures always block allocation and shift start, with no
  override.** This covers an expired licence, no MOT or insurance, and a critical defect.
- Only policy-level gaps (competence) can have a time-limited exception, from a named approver,
  for at most 7 days.
- History is append-only: corrections are recorded as amendments.

## 4. Operations

- **Restore after data loss:** `docs/runbooks/restore.md`. Drill it quarterly.
- **Alerts:** availability, errors, database pressure, an audit-chain failure and the budget all
  email the operations address set at deployment.
- **Downtime:** crews follow the downtime procedure ("call control"). The crew app keeps working
  offline and sends its work when the connection returns.
