# Accessibility scan (NFR-03, WCAG 2.2 AA)

Automated pass with axe-core 4.14.0 in Chromium (`node tests/a11y/scan.mjs`), 2026-11-02, against the web app running locally with seeded and pilot-profile synthetic data (manager view). Rules run: WCAG 2.0/2.1 A and AA and WCAG 2.2 AA tags (25–27 rules applicable per screen).

| Screen                       | Rule | Impact | Elements | Description   |
| ---------------------------- | ---- | ------ | -------- | ------------- |
| Sign in                      | –    | none   | 0        | No violations |
| Dashboard                    | –    | none   | 0        | No violations |
| Staff list                   | –    | none   | 0        | No violations |
| Staff profile                | –    | none   | 0        | No violations |
| Vehicles                     | –    | none   | 0        | No violations |
| Vehicle detail               | –    | none   | 0        | No violations |
| Compliance                   | –    | none   | 0        | No violations |
| Premises                     | –    | none   | 0        | No violations |
| Work planner                 | –    | none   | 0        | No violations |
| Reports                      | –    | none   | 0        | No violations |
| Settings                     | –    | none   | 0        | No violations |
| Settings – import and export | –    | none   | 0        | No violations |
| Settings – data protection   | –    | none   | 0        | No violations |

**Result: no violations on the 13 screens (sign-in added after M8).** Automated tools find only part of WCAG failures; the manual checks still due are listed in `accessibility-statement.md`.
