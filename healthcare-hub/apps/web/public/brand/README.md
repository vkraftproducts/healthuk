# Brand assets

| File                     | What it is                                                                        |
| ------------------------ | --------------------------------------------------------------------------------- |
| `logo.svg`               | Primary logo mark: **Pulse Cross** (option 2)                                     |
| `logo-lockup.svg`        | Primary mark with the "Healthcare Hub" wordmark (wordmark is outlined, no fonts)  |
| `logo-backup.svg`        | Approved backup mark: **Rapid Response** ambulance (option 9)                     |
| `logo-backup-lockup.svg` | Backup mark with the wordmark                                                     |
| `logo-options/`          | All ten options that were considered (marks and lockups), for reference           |
| `../favicon.svg`         | Browser tab icon (same artwork as `logo.svg`)                                     |

To use the backup logo in the web app set `VITE_BRAND_LOGO=rapid` at build time and copy
`logo-backup.svg` over `../favicon.svg`. The in-app mark is drawn in `src/brand.tsx`
(`BrandLogo`, variants `pulse` and `rapid`).
