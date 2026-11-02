param prefix string
param location string
param dailyCapGb int

resource law 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-law'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    workspaceCapping: { dailyQuotaGb: dailyCapGb }
  }
}

resource appi 'Microsoft.Insights/components@2020-02-02' = {
  name: '${prefix}-appi'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: law.id
    SamplingPercentage: 20
    DisableIpMasking: false
  }
}

output appInsightsConnectionString string = appi.properties.ConnectionString
output appInsightsId string = appi.id
output logAnalyticsId string = law.id
output logAnalyticsCustomerId string = law.properties.customerId
#disable-next-line outputs-should-not-contain-secrets
output logAnalyticsSharedKey string = law.listKeys().primarySharedKey
