#!/usr/bin/env node

const dotenv = require('dotenv');
const { DatabaseMaintenance } = require('../dist/util/database/DatabaseMaintenance');

// Load environment variables from .env.server
dotenv.config({ path: '.env.server' });

async function cleanupInvalidJson() {
  const maintenance = new DatabaseMaintenance({
    connectionString: process.env.CSS_IDENTITY_DB_URL || process.env.CSS_SPARQL_ENDPOINT
  });

  try {
    console.log('Starting database maintenance...');
    
    // Clean invalid JSON values
    const cleanedCount = await maintenance.cleanInvalidJsonValues('internal_kv');
    
    // Get table statistics
    console.log('\nTable statistics:');
    const stats = await maintenance.getTableStats();
    Object.entries(stats).forEach(([table, count]) => {
      console.log(`  ${table}: ${count} rows`);
    });
    
  } catch (error) {
    console.error('Error during database maintenance:', error);
    process.exit(1);
  } finally {
    await maintenance.close();
    console.log('Database maintenance completed.');
  }
}

cleanupInvalidJson().catch(console.error);