// Operational alerts (NFR-01): availability, errors, database pressure, audit-chain integrity.
param prefix string
param location string
param alertEmail string
param appInsightsId string
param logAnalyticsId string
param postgresId string
param apiUrl string

resource ag 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: '${prefix}-ops'
  location: 'global'
  properties: {
    groupShortName: 'hubops'
    enabled: true
    emailReceivers: [{ name: 'ops', emailAddress: alertEmail, useCommonAlertSchema: true }]
  }
}

// Synthetic availability check of /readyz from UK locations every 5 minutes.
resource ready 'Microsoft.Insights/webtests@2022-06-15' = {
  name: '${prefix}-readyz'
  location: location
  kind: 'standard'
  tags: { 'hidden-link:${appInsightsId}': 'Resource' }
  properties: {
    SyntheticMonitorId: '${prefix}-readyz'
    Name: '${prefix} readyz'
    Enabled: true
    Frequency: 300
    Timeout: 30
    Kind: 'standard'
    RetryEnabled: true
    Locations: [{ Id: 'emea-gb-db3-azr' }, { Id: 'emea-se-sto-edge' }, { Id: 'emea-nl-ams-azr' }]
    Request: { RequestUrl: '${apiUrl}/readyz', HttpVerb: 'GET' }
    ValidationRules: { ExpectedHttpStatusCode: 200, SSLCheck: true, SSLCertRemainingLifetimeCheck: 14 }
  }
}

resource availability 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${prefix}-availability'
  location: 'global'
  properties: {
    severity: 1
    enabled: true
    scopes: [ready.id, appInsightsId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.WebtestLocationAvailabilityCriteria'
      webTestId: ready.id
      componentId: appInsightsId
      failedLocationCount: 2
    }
    actions: [{ actionGroupId: ag.id }]
  }
}

resource pgCpu 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${prefix}-pg-cpu'
  location: 'global'
  properties: {
    severity: 2
    enabled: true
    scopes: [postgresId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        { name: 'cpu', metricName: 'cpu_percent', operator: 'GreaterThan', threshold: 80, timeAggregation: 'Average', criterionType: 'StaticThresholdCriterion' }
      ]
    }
    actions: [{ actionGroupId: ag.id }]
  }
}

resource pgStorage 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${prefix}-pg-storage'
  location: 'global'
  properties: {
    severity: 2
    enabled: true
    scopes: [postgresId]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT30M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        { name: 'storage', metricName: 'storage_percent', operator: 'GreaterThan', threshold: 80, timeAggregation: 'Maximum', criterionType: 'StaticThresholdCriterion' }
      ]
    }
    actions: [{ actionGroupId: ag.id }]
  }
}

// The nightly verification job logs "AUDIT CHAIN BROKEN" if the hash chain fails (SEC-03).
resource chain 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: '${prefix}-audit-chain'
  location: location
  properties: {
    severity: 0
    enabled: true
    scopes: [logAnalyticsId]
    evaluationFrequency: 'PT1H'
    windowSize: 'P1D'
    criteria: {
      allOf: [
        {
          query: 'ContainerAppConsoleLogs_CL | where Log_s has "AUDIT CHAIN BROKEN"'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
        }
      ]
    }
    actions: { actionGroups: [ag.id] }
  }
}

resource errors 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: '${prefix}-api-5xx'
  location: location
  properties: {
    severity: 2
    enabled: true
    scopes: [appInsightsId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: 'requests | where toint(resultCode) >= 500'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 10
          failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
        }
      ]
    }
    actions: { actionGroups: [ag.id] }
  }
}
