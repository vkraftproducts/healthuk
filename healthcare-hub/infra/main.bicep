// Healthcare Hub - pilot footprint (docs/ARCHITECTURE.md §5). UK South primary, UK West backups.
// STATUS: not yet compiled or deployed from the build environment (no Azure CLI/Bicep access).
// Before first use: `az bicep build -f infra/main.bicep` and
// `az deployment group what-if -g <rg> -f infra/main.bicep -p infra/params/<env>.bicepparam`.
targetScope = 'resourceGroup'

@description('Environment name, used in resource names.')
param env string
param location string = 'uksouth'
@description('Postgres administrator login (password is generated into Key Vault by the deploy job).')
param pgAdminLogin string = 'hubadmin'
@secure()
param pgAdminPassword string
@description('Daily cap (GB) for Log Analytics ingestion - keeps the pilot inside budget.')
param logDailyCapGb int = 1
@description('Monthly budget for this resource group (GBP).')
param budgetGbp int
@description('Budget start: first day of the current month, YYYY-MM-01.')
param budgetStart string
param alertEmail string
param imageRegistry string
param imageTag string
param publicApiUrl string
param webOrigin string
param oidcIssuer string
param oidcAudience string = 'healthcare-hub-api'
@description('Zone-redundant Postgres HA (post-pilot upgrade; General Purpose tier).')
param postgresHa bool = false

var prefix = 'hub-${env}'
var prod = env == 'prod'

module monitoring 'modules/monitoring.bicep' = {
  name: 'monitoring'
  params: { prefix: prefix, location: location, dailyCapGb: logDailyCapGb }
}

module storage 'modules/storage.bicep' = {
  name: 'storage'
  params: { prefix: replace(prefix, '-', ''), location: location }
}

module keyvault 'modules/keyvault.bicep' = {
  name: 'keyvault'
  params: { prefix: prefix, location: location }
}

module postgres 'modules/postgres.bicep' = {
  name: 'postgres'
  params: {
    prefix: prefix
    location: location
    adminLogin: pgAdminLogin
    adminPassword: pgAdminPassword
    // Burstable B1ms for staging, B2s for production (ARCHITECTURE §7: zone-redundant HA is the
    // upgrade path beyond the pilot; set postgresHa = true with a General Purpose SKU then).
    skuName: postgresHa ? 'Standard_D2ds_v5' : (prod ? 'Standard_B2s' : 'Standard_B1ms')
    highAvailability: postgresHa
  }
}

module apps 'modules/containerapps.bicep' = {
  name: 'apps'
  params: {
    prefix: prefix
    location: location
    logAnalyticsCustomerId: monitoring.outputs.logAnalyticsCustomerId
    logAnalyticsSharedKey: monitoring.outputs.logAnalyticsSharedKey
    keyVaultName: keyvault.outputs.name
    imageRegistry: imageRegistry
    imageTag: imageTag
    publicApiUrl: publicApiUrl
    webOrigin: webOrigin
    oidcIssuer: oidcIssuer
    oidcAudience: oidcAudience
    apiMinReplicas: prod ? 2 : 1
  }
}

module web 'modules/web.bicep' = {
  name: 'web'
  params: { prefix: prefix }
}

module alerts 'modules/alerts.bicep' = {
  name: 'alerts'
  params: {
    prefix: prefix
    location: location
    alertEmail: alertEmail
    appInsightsId: monitoring.outputs.appInsightsId
    logAnalyticsId: monitoring.outputs.logAnalyticsId
    postgresId: postgres.outputs.id
    apiUrl: publicApiUrl
  }
}

module budget 'modules/budget.bicep' = {
  name: 'budget'
  params: { prefix: prefix, amountGbp: budgetGbp, contactEmails: [alertEmail], startDate: budgetStart }
}

output storageAccountName string = storage.outputs.name
output keyVaultName string = keyvault.outputs.name
output postgresHost string = postgres.outputs.fqdn
output apiFqdn string = apps.outputs.apiFqdn
output webHostname string = web.outputs.hostname
output appInsightsConnectionString string = monitoring.outputs.appInsightsConnectionString
