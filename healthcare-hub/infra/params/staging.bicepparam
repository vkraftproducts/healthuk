using '../main.bicep'

param env = 'staging'
param location = 'uksouth'
// pgAdminPassword is supplied by the deploy job from Key Vault / a secret, never committed.
param pgAdminPassword = readEnvironmentVariable('PG_ADMIN_PASSWORD')
param budgetGbp = 150
param budgetStart = readEnvironmentVariable('BUDGET_START', '2026-12-01')
param alertEmail = readEnvironmentVariable('OPS_ALERT_EMAIL')
param imageRegistry = readEnvironmentVariable('IMAGE_REGISTRY')
param imageTag = readEnvironmentVariable('IMAGE_TAG')
param publicApiUrl = 'https://api.staging.healthcarehub.example'
param webOrigin = 'https://app.staging.healthcarehub.example'
param oidcIssuer = readEnvironmentVariable('OIDC_ISSUER')
