param prefix string
param location string
param adminLogin string
@secure()
param adminPassword string
param skuName string
@description('Zone-redundant high availability (production).')
param highAvailability bool = false

resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: '${prefix}-pg'
  location: location
  sku: { name: skuName, tier: highAvailability ? 'GeneralPurpose' : 'Burstable' }
  properties: {
    version: '16'
    administratorLogin: adminLogin
    administratorLoginPassword: adminPassword
    storage: { storageSizeGB: 64 }
    backup: { backupRetentionDays: 35, geoRedundantBackup: 'Enabled' } // PITR 35 days, geo copy in UK West
    // Production: zone-redundant standby in UK South; staging: none.
    highAvailability: { mode: highAvailability ? 'ZoneRedundant' : 'Disabled' }
    authConfig: { passwordAuth: 'Enabled', activeDirectoryAuth: 'Disabled' }
  }
}

resource db 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: pg
  name: 'hub'
}

// btree_gist is required for the allocation exclusion constraint (M6).
resource exts 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: pg
  name: 'azure.extensions'
  properties: { value: 'BTREE_GIST,PGCRYPTO', source: 'user-override' }
}

output fqdn string = pg.properties.fullyQualifiedDomainName
output id string = pg.id
