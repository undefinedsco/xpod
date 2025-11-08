const { Client } = require('pg');

async function checkData() {
  const client = new Client({
    connectionString: 'postgresql://postgres:f5xzqbpt@dbconn.sealosgzg.site:47435/',
  });

  try {
    await client.connect();
    
    // Check all tables first
    console.log('\n=== All tables ===');
    const tablesResult = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name LIKE '%kv%'
    `);
    tablesResult.rows.forEach(row => {
      console.log(`Table: ${row.table_name}`);
    });
    
    // Check table structure
    console.log('\n=== Table structure ===');
    const structResult = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'internal_kv'
    `);
    structResult.rows.forEach(row => {
      console.log(`${row.column_name}: ${row.data_type}`);
    });
    
    // Check for problematic values  
    console.log('\n=== All records ===');
    const allResult = await client.query(`
      SELECT key, value, value::text as value_text, updated_at 
      FROM internal_kv 
      ORDER BY updated_at DESC 
      LIMIT 20
    `);
    
    allResult.rows.forEach(row => {
      console.log(`Key: ${row.key}`);
      console.log(`Value (object): ${typeof row.value} - ${JSON.stringify(row.value)}`);
      console.log(`Value (text): ${row.value_text}`);
      console.log(`Updated: ${row.updated_at}`);
      console.log('---');
    });
    
    // Check specifically for values that start with /.internal/
    console.log('\n=== /.internal/ namespace records ===');
    const internalResult = await client.query(`
      SELECT key, value, value::text as value_text, updated_at 
      FROM internal_kv 
      WHERE key LIKE '/.internal/%'
      ORDER BY updated_at DESC 
    `);
    internalResult.rows.forEach(row => {
      console.log(`Key: ${row.key}`);
      console.log(`Value (object): ${typeof row.value} - ${JSON.stringify(row.value)}`);
      console.log(`Value (text): ${row.value_text}`);
      console.log('---');
    });

    console.log('\n=== Problematic values ===');
    const problemResult = await client.query(`
      SELECT key, value::text, updated_at 
      FROM internal_kv 
      WHERE value::text = '[object Object]' 
         OR value::text = '"[object Object]"'
         OR value::text = 'undefined'
         OR value::text = 'null'
         OR value::text = ''
         OR value::text LIKE '%[object Object]%'
         OR (value::text NOT LIKE '{%' AND value::text != 'true' AND value::text != 'false' AND value::text !~ '^[0-9]+(\.[0-9]+)?$' AND value::text !~ '^".*"$')
    `);
    
    console.log('\n=== Raw string values (not JSON wrapped) ===');
    const rawResult = await client.query(`
      SELECT key, value::text, updated_at 
      FROM internal_kv 
      WHERE value::text NOT LIKE '{%'
        AND value::text NOT LIKE '[%'
        AND value::text NOT LIKE '"%'
        AND value::text != 'true' 
        AND value::text != 'false' 
        AND value::text !~ '^[0-9]+(\.[0-9]+)?$'
    `);
    
    console.log(`Found ${problemResult.rows.length} problematic records:`);
    problemResult.rows.forEach(row => {
      console.log(`Key: ${row.key}, Value: "${row.value}", Updated: ${row.updated_at}`);
    });
    
    console.log(`\nFound ${rawResult.rows.length} raw string values:`);
    rawResult.rows.forEach(row => {
      console.log(`Key: ${row.key}, Value: "${row.value}", Updated: ${row.updated_at}`);
    });
    
    // Check test_kv table if exists
    console.log('\n=== Checking test_kv table ===');
    try {
      const testResult = await client.query(`
        SELECT key, value::text, updated_at 
        FROM test_kv 
        ORDER BY updated_at DESC 
        LIMIT 10
      `);
      console.log(`Found ${testResult.rows.length} records in test_kv:`);
      testResult.rows.forEach(row => {
        console.log(`Key: ${row.key}, Value: "${row.value}", Updated: ${row.updated_at}`);
      });
      
      const testProblemResult = await client.query(`
        SELECT key, value::text, updated_at 
        FROM test_kv 
        WHERE value::text = '[object Object]' 
           OR value::text = '"[object Object]"'
           OR value::text LIKE '%[object Object]%'
      `);
      console.log(`Found ${testProblemResult.rows.length} problematic records in test_kv:`);
      testProblemResult.rows.forEach(row => {
        console.log(`Key: ${row.key}, Value: "${row.value}", Updated: ${row.updated_at}`);
      });
    } catch (err) {
      console.log(`test_kv table check failed: ${err.message}`);
    }

  } catch (error) {
    console.error('Database connection error:', error);
  } finally {
    await client.end();
  }
}

checkData();