// Monthly cost budget for the resource group with actual and forecast alerts.
param prefix string
param amountGbp int
param contactEmails array
param startDate string

resource budget 'Microsoft.Consumption/budgets@2023-11-01' = {
  name: '${prefix}-budget'
  properties: {
    category: 'Cost'
    amount: amountGbp
    timeGrain: 'Monthly'
    timePeriod: { startDate: startDate }
    notifications: {
      actual80: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 80, thresholdType: 'Actual', contactEmails: contactEmails }
      actual100: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 100, thresholdType: 'Actual', contactEmails: contactEmails }
      forecast100: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 100, thresholdType: 'Forecasted', contactEmails: contactEmails }
    }
  }
}
