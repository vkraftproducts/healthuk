// API, worker and web on Azure Container Apps (Consumption), UK South. Managed identity reads
// secrets from Key Vault; no secrets in the template.
param prefix string
param location string
param logAnalyticsCustomerId string
@secure()
param logAnalyticsSharedKey string
param keyVaultName string
param imageRegistry string
param imageTag string
param publicApiUrl string
param webOrigin string
param oidcIssuer string
param oidcAudience string
param apiMinReplicas int = 1

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${prefix}-cae'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: { customerId: logAnalyticsCustomerId, sharedKey: logAnalyticsSharedKey }
    }
  }
}

var kvUri = 'https://${keyVaultName}${environment().suffixes.keyvaultDns}/secrets'
var secrets = [
  { name: 'database-url', keyVaultUrl: '${kvUri}/database-url', identity: 'system' }
  { name: 'queue-database-url', keyVaultUrl: '${kvUri}/queue-database-url', identity: 'system' }
  { name: 'blob-signing-secret', keyVaultUrl: '${kvUri}/blob-signing-secret', identity: 'system' }
  { name: 'field-encryption-key', keyVaultUrl: '${kvUri}/field-encryption-key', identity: 'system' }
  { name: 'ip-hash-secret', keyVaultUrl: '${kvUri}/ip-hash-secret', identity: 'system' }
  { name: 'expo-access-token', keyVaultUrl: '${kvUri}/expo-access-token', identity: 'system' }
]
var commonEnv = [
  { name: 'NODE_ENV', value: 'production' }
  { name: 'DATABASE_URL', secretRef: 'database-url' }
  { name: 'WEB_ORIGIN', value: webOrigin }
  { name: 'LOG_LEVEL', value: 'info' }
]

resource api 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${prefix}-api'
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      ingress: { external: true, targetPort: 4000, transport: 'http', allowInsecure: false }
      secrets: secrets
    }
    template: {
      containers: [
        {
          name: 'api'
          image: '${imageRegistry}/hub-api:${imageTag}'
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: concat(commonEnv, [
            { name: 'API_PORT', value: '4000' }
            { name: 'PUBLIC_API_URL', value: publicApiUrl }
            { name: 'OIDC_ISSUER', value: oidcIssuer }
            { name: 'OIDC_AUDIENCE', value: oidcAudience }
            { name: 'OIDC_JWKS_URI', value: '${oidcIssuer}/discovery/v2.0/keys' }
            { name: 'BLOB_SIGNING_SECRET', secretRef: 'blob-signing-secret' }
            { name: 'FIELD_ENCRYPTION_KEY', secretRef: 'field-encryption-key' }
            { name: 'IP_HASH_SECRET', secretRef: 'ip-hash-secret' }
          ])
          probes: [
            { type: 'Liveness', httpGet: { path: '/healthz', port: 4000 }, periodSeconds: 30 }
            { type: 'Readiness', httpGet: { path: '/readyz', port: 4000 }, periodSeconds: 15 }
          ]
        }
      ]
      // NFR-02 pilot load fits one replica; a second absorbs bursts and restarts.
      scale: { minReplicas: apiMinReplicas, maxReplicas: 3, rules: [{ name: 'http', http: { metadata: { concurrentRequests: '50' } } }] }
    }
  }
}

resource worker 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${prefix}-worker'
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    managedEnvironmentId: env.id
    configuration: { secrets: secrets }
    template: {
      containers: [
        {
          name: 'worker'
          image: '${imageRegistry}/hub-worker:${imageTag}'
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: concat(commonEnv, [
            { name: 'QUEUE_DATABASE_URL', secretRef: 'queue-database-url' }
            { name: 'PUSH_PROVIDER', value: 'expo' }
            { name: 'EXPO_ACCESS_TOKEN', secretRef: 'expo-access-token' }
          ])
        }
      ]
      // Exactly one worker: pg-boss schedules must not run twice.
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}

output apiPrincipalId string = api.identity.principalId
output workerPrincipalId string = worker.identity.principalId
output apiFqdn string = api.properties.configuration.ingress.fqdn
