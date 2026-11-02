param prefix string
param location string

resource sa 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: take('${prefix}st', 24)
  location: location
  sku: { name: 'Standard_GRS' } // UK South -> UK West
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false // managed identity / user-delegation SAS only
    supportsHttpsTrafficOnly: true
  }
}

resource blob 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: sa
  name: 'default'
  properties: {
    isVersioningEnabled: true
    deleteRetentionPolicy: { enabled: true, days: 30 }
    containerDeleteRetentionPolicy: { enabled: true, days: 30 }
  }
}

resource quarantine 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blob
  name: 'quarantine'
}
resource evidence 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blob
  name: 'evidence'
}
resource exports 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blob
  name: 'exports'
}
// Daily audit-chain head anchors are written here and made immutable (WORM).
resource anchors 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blob
  name: 'audit-anchors'
  properties: {
    immutableStorageWithVersioning: { enabled: true }
  }
}

resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: sa
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'expire-exports'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: { blobTypes: ['blockBlob'], prefixMatch: ['exports/'] }
            actions: { baseBlob: { delete: { daysAfterModificationGreaterThan: 7 } } }
          }
        }
      ]
    }
  }
}

output name string = sa.name

// Malware scanning on upload (SECURITY_COMPLIANCE §5): files stay in quarantine until scanned.
resource defender 'Microsoft.Security/defenderForStorageSettings@2022-12-01-preview' = {
  name: 'current'
  scope: sa
  properties: {
    isEnabled: true
    malwareScanning: { onUpload: { isEnabled: true, capGBPerMonth: 50 } }
    sensitiveDataDiscovery: { isEnabled: false }
    overrideSubscriptionLevelSettings: true
  }
}
