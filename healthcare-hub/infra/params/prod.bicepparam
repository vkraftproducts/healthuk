using '../main.bicep'

param env = 'prod'
param location = 'uksouth'
// Secrets come from the deploy job (Key Vault / pipeline secrets), never from this file.
param pgAdminPassword = readEnvironmentVariable('PG_ADMIN_PASSWORD')
param logDailyCapGb = 2
// Assumed pilot budget (see DECISIONS M8); alerts at 80 % and 100 % actual, 100 % forecast.
param budgetGbp = 450
param budgetStart = readEnvironmentVariable('BUDGET_START', '2026-12-01')
param alertEmail = readEnvironmentVariable('OPS_ALERT_EMAIL')
param imageRegistry = readEnvironmentVariable('IMAGE_REGISTRY')
param imageTag = readEnvironmentVariable('IMAGE_TAG')
param publicApiUrl = 'https://api.healthcarehub.example'
param webOrigin = 'https://app.healthcarehub.example'
param oidcIssuer = readEnvironmentVariable('OIDC_ISSUER')
