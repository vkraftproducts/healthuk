// Web SPA on Static Web Apps (Standard). Static assets only: no personal data is stored here.
// Static Web Apps is not offered in UK regions; the content is served from the global edge.
param prefix string
resource swa 'Microsoft.Web/staticSites@2023-12-01' = {
  name: '${prefix}-web'
  location: 'westeurope'
  sku: { name: 'Standard', tier: 'Standard' }
  properties: { stagingEnvironmentPolicy: 'Disabled', allowConfigFileUpdates: true }
}
output hostname string = swa.properties.defaultHostname
